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

/**
 * Copy the checked-in app files into a fixture without pulling generated
 * workspaces (for example, Rust's target directory) along with them.
 *
 * Git's NUL-delimited output keeps paths containing whitespace/newlines safe,
 * while explicitly handling symlinks keeps the fixture equivalent to a
 * checkout rather than dereferencing them.
 */
async function copyTrackedApp(sourceRoot, destinationApp) {
  const { stdout } = await git(sourceRoot, ['ls-files', '-z', '--', 'app']);
  await fs.mkdir(destinationApp, { recursive: true });

  for (const trackedPath of stdout.split('\0').filter(Boolean)) {
    if (!trackedPath.startsWith('app/')) {
      throw new Error(`Unexpected tracked path outside app/: ${trackedPath}`);
    }
    const relativePath = trackedPath.slice('app/'.length);
    const sourcePath = path.join(sourceRoot, ...trackedPath.split('/'));
    const destinationPath = path.join(destinationApp, ...relativePath.split('/'));
    const stat = await fs.lstat(sourcePath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });

    if (stat.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(sourcePath), destinationPath);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Tracked app path is not a file or symlink: ${trackedPath}`);
    }
    await fs.copyFile(sourcePath, destinationPath);
    // Preserve executable bits on platforms that expose them.  This keeps
    // git's mode checks stable while remaining a no-op on Windows filesystems.
    await fs.chmod(destinationPath, stat.mode & 0o777);
  }
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

test('real-tree fixture excludes untracked generated target files', async t => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'ride-tracked-app-'));
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'ride-tracked-copy-'));
  t.after(() => Promise.all([
    fs.rm(source, { recursive: true, force: true }),
    fs.rm(destination, { recursive: true, force: true }),
  ]));

  const trackedFile = path.join(source, 'app', 'tracked.txt');
  await fs.mkdir(path.dirname(trackedFile), { recursive: true });
  await fs.writeFile(trackedFile, 'tracked\n');
  await git(source, ['init', '-b', 'master']);
  await git(source, ['config', 'user.name', 'RIDE test']);
  await git(source, ['config', 'user.email', 'ride-test@example.invalid']);
  await git(source, ['add', 'app']);
  await git(source, ['commit', '-m', 'tracked app fixture']);

  const generatedFile = path.join(
    source,
    'app',
    'applications',
    'tauri',
    'src-tauri',
    'target',
    'debug',
    'generated.rmeta',
  );
  await fs.mkdir(path.dirname(generatedFile), { recursive: true });
  await fs.writeFile(generatedFile, 'generated\n');

  await copyTrackedApp(source, destination);
  assert.equal(await fs.readFile(path.join(destination, 'tracked.txt'), 'utf8'), 'tracked\n');
  await assert.rejects(fs.access(path.join(destination, 'applications', 'tauri', 'src-tauri', 'target')));
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
  await copyTrackedApp(repositoryRoot, path.join(fixture, 'app'));
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
