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
const pinnedCommit = 'a868f5b15f2d4f2598125a4f6a98c0d29990b946';

async function git(cwd, args) {
  return execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

test('real product tree has zero drift against pinned upstream plus owned paths and patches', async t => {
  const upstream = process.env.RIDE_PINNED_UPSTREAM
    ?? path.join(os.tmpdir(), 'theia-ide-baseline-81d90af51b6a4ce6b609b505dd783d7c');
  try {
    const stat = await fs.stat(upstream);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    t.skip(`pinned upstream checkout unavailable: ${upstream}`);
    return;
  }

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
