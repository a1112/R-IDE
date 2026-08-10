import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const script = path.resolve('scripts/sync-upstream.mjs');

async function git(cwd, args) {
  return execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

async function write(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ride-upstream-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'master']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']);
  const upstream = path.join(root, 'upstream');
  await fs.mkdir(upstream);
  await git(upstream, ['init', '-b', 'master']);
  await git(upstream, ['config', 'user.name', 'Fixture']);
  await git(upstream, ['config', 'user.email', 'fixture@example.invalid']);
  await git(upstream, ['config', 'core.autocrlf', 'false']);
  await write(path.join(upstream, 'hello.txt'), 'hello baseline\n');
  await git(upstream, ['add', '.']);
  await git(upstream, ['commit', '-m', 'baseline']);
  const baseline = (await git(upstream, ['rev-parse', 'HEAD'])).stdout.trim();
  await write(path.join(upstream, 'hello.txt'), 'hello target\n');
  await write(path.join(upstream, 'new.txt'), 'new file\n');
  await git(upstream, ['add', '.']);
  await git(upstream, ['commit', '-m', 'target']);
  const target = (await git(upstream, ['rev-parse', 'HEAD'])).stdout.trim();
  const app = path.join(root, 'app');
  await write(path.join(app, 'hello.txt'), 'hello baseline\n');
  await write(path.join(root, '.upstream', 'source.json'), JSON.stringify({ repository: upstream, branch: 'master', commit: baseline }, null, 2) + '\n');
  await write(path.join(root, '.upstream', 'owned-paths.txt'), '# fixture\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'fixture']);
  return { root, app, upstream, baseline, target };
}

async function runCli(fixtureData, args) {
  try {
    const result = await execFileAsync(process.execPath, [script, ...args, '--root', fixtureData.root], { encoding: 'utf8' });
    return { ...result, code: 0 };
  } catch (error) {
    return { ...error, code: error.code ?? 1 };
  }
}

test('check reports no drift for the configured baseline', async t => {
  const f = await fixture(t);
  const result = await runCli(f, ['check', '--json']);
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.changed, false);
  assert.equal(report.previousCommit, f.baseline);
  assert.equal(report.targetCommit, f.baseline);
});

test('check exits non-zero when tracked product content drifts', async t => {
  const f = await fixture(t);
  await write(path.join(f.app, 'hello.txt'), 'drifted\n');
  const result = await runCli(f, ['check']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /drift/i);
});

test('sync dry-run reports changes without modifying app or metadata', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.app, 'hello.txt'), 'utf8');
  const result = await runCli(f, ['sync', '--target', f.target, '--dry-run', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.changed, true);
  assert.equal(await fs.readFile(path.join(f.app, 'hello.txt'), 'utf8'), before);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, '.upstream/source.json'), 'utf8')).commit, f.baseline);
});

test('sync advances source metadata and supports no-op reports', async t => {
  const f = await fixture(t);
  const result = await runCli(f, ['sync', '--target', f.target, '--json']);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.targetCommit, f.target);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, '.upstream/source.json'), 'utf8')).commit, f.target);
  const noOp = await runCli(f, ['sync', '--target', f.target, '--json']);
  assert.equal(noOp.code, 0, noOp.stderr);
  assert.equal(JSON.parse(noOp.stdout).changed, false);
});

test('writes structured reports and rejects unknown flags', async t => {
  const f = await fixture(t);
  const reportPath = path.join(f.root, 'report.json');
  const result = await runCli(f, ['sync', '--target', f.target, '--dry-run', '--report', reportPath]);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  for (const field of ['changed', 'previousCommit', 'targetCommit', 'counts', 'ownedPaths', 'patches', 'compareUrl']) assert.ok(Object.hasOwn(report, field), field);
  const unknown = await runCli(f, ['check', '--wat']);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /unknown flag/i);
});

test('refresh-patches is reproducible', async t => {
  const f = await fixture(t);
  await write(path.join(f.app, 'hello.txt'), 'patched product\n');
  const first = await runCli(f, ['refresh-patches', '--json']);
  assert.equal(first.code, 0, first.stderr);
  const patchPath = path.join(f.root, '.upstream', 'patches', '0001-upstream.patch');
  const contents = await fs.readFile(patchPath, 'utf8');
  const second = await runCli(f, ['refresh-patches', '--json']);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(await fs.readFile(patchPath, 'utf8'), contents);
});

test('refresh-patches reports false when an already-empty patch remains empty', async t => {
  const f = await fixture(t);
  const patchPath = path.join(f.root, '.upstream', 'patches', '0001-upstream.patch');
  await fs.mkdir(path.dirname(patchPath), { recursive: true });
  await fs.writeFile(patchPath, '');
  const result = await runCli(f, ['refresh-patches', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).changed, false);
  await assert.rejects(fs.access(patchPath));
});

test('refresh-patches reports false on the first empty patch with no patch file', async t => {
  const f = await fixture(t);
  const result = await runCli(f, ['refresh-patches', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).changed, false);
  await assert.rejects(fs.access(path.join(f.root, '.upstream', 'patches', '0001-upstream.patch')));
});

test('refresh-patches rejects a symlinked repository root', async t => {
  const f = await fixture(t);
  const link = path.join(path.dirname(f.root), 'ride-cli-root-link');
  try {
    await fs.symlink(f.root, link, 'junction');
  } catch (error) {
    if (process.platform === 'win32' && ['EACCES', 'EPERM', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`symlinks unavailable on this Windows host: ${error.code}`);
      return;
    }
    throw error;
  }
  t.after(() => fs.rm(link, { recursive: true, force: true }));
  const result = await runCli({ ...f, root: link }, ['refresh-patches']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /symlink|symbolic link|real directory|repository root/i);
});
