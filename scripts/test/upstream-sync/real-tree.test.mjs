import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const script = path.join(repositoryRoot, 'scripts', 'sync-upstream.mjs');
const sourceMetadata = JSON.parse(await fs.readFile(path.join(repositoryRoot, '.upstream', 'source.json'), 'utf8'));
const pinnedCommit = sourceMetadata.commit;

async function git(cwd, args) {
  return execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

async function resolvePinnedCheckout(source, override = process.env.RIDE_PINNED_UPSTREAM) {
  if (override) {
    let stat;
    try {
      stat = await fs.stat(override);
    } catch (error) {
      throw new Error(`RIDE_PINNED_UPSTREAM does not exist: ${override}`, { cause: error });
    }
    if (!stat.isDirectory()) {
      throw new Error(`RIDE_PINNED_UPSTREAM is not a directory: ${override}`);
    }
    const head = (await git(override, ['rev-parse', 'HEAD'])).stdout.trim().toLowerCase();
    if (head !== source.commit.toLowerCase()) {
      throw new Error(`RIDE_PINNED_UPSTREAM must be checked out at ${source.commit}, got ${head}`);
    }
    return { path: override, cleanup: async () => {} };
  }

  const checkout = await fs.mkdtemp(path.join(os.tmpdir(), 'ride-real-upstream-'));
  try {
    await fs.rm(checkout, { recursive: true, force: true });
    await execFileAsync('git', ['clone', '--filter=blob:none', '--no-checkout', source.repository, checkout], { encoding: 'utf8' });
    await git(checkout, ['checkout', '--detach', '--quiet', source.commit]);
    return { path: checkout, cleanup: () => fs.rm(checkout, { recursive: true, force: true }) };
  } catch (error) {
    await fs.rm(checkout, { recursive: true, force: true });
    throw new Error(`Unable to obtain pinned upstream ${source.commit} from ${source.repository}`, { cause: error });
  }
}

test('fails when the explicit pinned upstream override is missing', async t => {
  const missing = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'ride-missing-upstream-')), 'missing');
  t.after(() => fs.rm(path.dirname(missing), { recursive: true, force: true }));
  await assert.rejects(
    resolvePinnedCheckout(sourceMetadata, missing),
    /RIDE_PINNED_UPSTREAM does not exist/,
  );
});

test('real product tree has zero drift against pinned upstream plus owned paths and patches', async t => {
  let upstreamHandle;
  try {
    upstreamHandle = await resolvePinnedCheckout(sourceMetadata);
  } catch (error) {
    assert.fail(error.message);
  }
  const upstream = upstreamHandle.path;
  t.after(upstreamHandle.cleanup);

  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'ride-real-tree-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  await fs.cp(path.join(repositoryRoot, 'app'), path.join(fixture, 'app'), { recursive: true });
  await fs.cp(path.join(repositoryRoot, '.upstream'), path.join(fixture, '.upstream'), { recursive: true });
  const sourceFile = path.join(fixture, '.upstream', 'source.json');
  const source = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
  await fs.writeFile(sourceFile, `${JSON.stringify({ ...source, repository: upstream, commit: pinnedCommit }, null, 2)}\n`);
  await git(fixture, ['init', '-b', 'master']);
  await git(fixture, ['config', 'user.name', 'RIDE test']);
  await git(fixture, ['config', 'user.email', 'ride-test@example.invalid']);
  await git(fixture, ['add', 'app']);
  await git(fixture, ['commit', '-m', 'real product tree fixture']);

  let result;
  try {
    result = await execFileAsync(process.execPath, [script, 'check', '--json', '--root', fixture], { encoding: 'utf8' });
  } catch (error) {
    assert.fail(`real-tree check failed (${error.code ?? 1}): ${error.stderr ?? ''}${error.stdout ?? ''}${error.message ?? ''}`);
  }
  const report = JSON.parse(result.stdout);
  assert.equal(report.drift, false);
  assert.equal(report.changed, false, JSON.stringify(report, null, 2));
  assert.equal(report.previousCommit, pinnedCommit);
  assert.equal(report.targetCommit, pinnedCommit);
});
