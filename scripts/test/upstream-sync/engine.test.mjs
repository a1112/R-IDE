import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { atomicReplace, restoreOwnedPaths, synchronize } from '../../lib/upstream-sync/engine.mjs';
import {
  assertAncestor,
  checkoutDetached,
  cloneRepository,
  compareTrackedTrees,
  generateBinaryDiff,
  isAncestor,
} from '../../lib/upstream-sync/git.mjs';
import { runCommand } from '../../lib/upstream-sync/command.mjs';

async function writeFile(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

async function git(cwd, args) {
  return runCommand('git', ['-C', cwd, ...args]);
}

async function gitOutput(cwd, args) {
  return (await git(cwd, args)).stdout.trim();
}

async function createGitRepository(root) {
  const repository = path.join(root, 'upstream');
  await fs.mkdir(repository, { recursive: true });
  await git(repository, ['init', '-b', 'master']);
  await git(repository, ['config', 'core.autocrlf', 'false']);
  await git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  await git(repository, ['config', 'user.name', 'Fixture']);
  return repository;
}

async function createSymlinkOrSkip(t, target, link, type = undefined) {
  try {
    await fs.symlink(target, link, type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EACCES', 'EPERM', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`symlinks unavailable on this Windows host: ${error.code}`);
      return false;
    }
    throw error;
  }
}

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ride-upstream-engine-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const repository = await createGitRepository(root);
  await writeFile(path.join(repository, 'keep.txt'), 'upstream baseline\n');
  await writeFile(path.join(repository, 'delete.txt'), 'delete me\n');
  await writeFile(path.join(repository, 'rename.txt'), 'rename me\n');
  await writeFile(path.join(repository, 'binary.dat'), Buffer.from([0, 1, 2, 255, 3]));
  await writeFile(path.join(repository, 'owned', 'upstream.txt'), 'upstream owned\n');
  await writeFile(path.join(repository, 'absent-owned.txt'), 'upstream absent\n');
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-m', 'baseline']);
  const baseline = await gitOutput(repository, ['rev-parse', 'HEAD']);

  await writeFile(path.join(repository, 'keep.txt'), 'upstream target\n');
  await fs.rm(path.join(repository, 'delete.txt'));
  await git(repository, ['mv', 'rename.txt', 'renamed.txt']);
  await writeFile(path.join(repository, 'add.txt'), 'new upstream file\n');
  await writeFile(path.join(repository, 'binary.dat'), Buffer.from([0, 255, 1, 2, 254, 3]));
  await writeFile(path.join(repository, 'owned', 'upstream.txt'), 'upstream target owned\n');
  await git(repository, ['add', '-A']);
  await git(repository, ['commit', '-m', 'target']);
  const target = await gitOutput(repository, ['rev-parse', 'HEAD']);

  const product = path.join(root, 'app');
  await fs.mkdir(product, { recursive: true });
  await writeFile(path.join(product, 'keep.txt'), 'upstream baseline\n');
  await writeFile(path.join(product, 'delete.txt'), 'delete me\n');
  await writeFile(path.join(product, 'rename.txt'), 'rename me\n');
  await writeFile(path.join(product, 'binary.dat'), Buffer.from([0, 1, 2, 255, 3]));
  await writeFile(path.join(product, 'owned', 'custom.txt'), 'product owned\n');

  const tempRoot = path.join(root, 'staging');
  await fs.mkdir(tempRoot);

  const options = {
    product,
    repositoryRoot: root,
    source: { repository, branch: 'master', commit: baseline },
    target,
    ownedPaths: ['owned/', 'absent-owned.txt'],
    tempRoot,
  };
  const conflictingPatch = [
    'diff --git a/keep.txt b/keep.txt',
    '--- a/keep.txt',
    '+++ b/keep.txt',
    '@@ -1 +1 @@',
    '-this context does not exist',
    '+conflicting patch',
    '',
  ].join('\n');
  const successfulPatch = [
    'diff --git a/keep.txt b/keep.txt',
    '--- a/keep.txt',
    '+++ b/keep.txt',
    '@@ -1 +1 @@',
    '-upstream target',
    '+patched target',
    '',
  ].join('\n');

  return {
    root,
    repository,
    product,
    tempRoot,
    baseline,
    target,
    options,
    conflictingPatch,
    successfulPatch,
  };
}

async function treeDigest(root) {
  const entries = [];
  async function visit(current, relative = '') {
    const children = await fs.readdir(current, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      const childPath = path.join(current, child.name);
      if (child.isDirectory()) {
        entries.push(`${childRelative}\0dir`);
        await visit(childPath, childRelative);
      } else if (child.isSymbolicLink()) {
        entries.push(`${childRelative}\0link\0${await fs.readlink(childPath)}`);
      } else {
        const data = await fs.readFile(childPath);
        entries.push(
          `${childRelative}\0file\0${crypto.createHash('sha256').update(data).digest('hex')}`,
        );
      }
    }
  }
  await visit(root);
  return crypto.createHash('sha256').update(entries.join('\n')).digest('hex');
}

test('captures command details when an external process fails', async () => {
  await assert.rejects(
    runCommand(process.execPath, ['-e', "console.error('fixture failure'); process.exit(7)" ]),
    error => {
      assert.equal(error.name, 'CommandError');
      assert.equal(error.executable, process.execPath);
      assert.deepEqual(error.args, ['-e', "console.error('fixture failure'); process.exit(7)" ]);
      assert.equal(error.exitCode, 7);
      assert.match(error.stderr, /fixture failure/);
      return true;
    },
  );
});

test('normalizes buffered command failure streams into a CommandError', async () => {
  await assert.rejects(
    runCommand(process.execPath, ['-e', 'process.exit(2)'], { encoding: null }),
    error => {
      assert.equal(error.name, 'CommandError');
      assert.equal(typeof error.stderr, 'string');
      assert.equal(typeof error.stdout, 'string');
      return true;
    },
  );
});

test('rebuilds upstream additions, edits, deletes, renames, and binary files', async t => {
  const fixture = await createFixture(t);
  await synchronize(fixture.options);

  const text = async relativePath => (await fs.readFile(path.join(fixture.product, relativePath), 'utf8')).replaceAll('\r\n', '\n');
  assert.equal(await text('keep.txt'), 'upstream target\n');
  assert.equal(await text('add.txt'), 'new upstream file\n');
  assert.equal(await text('renamed.txt'), 'rename me\n');
  assert.deepEqual(await fs.readFile(path.join(fixture.product, 'binary.dat')), Buffer.from([0, 255, 1, 2, 254, 3]));
  await assert.rejects(fs.access(path.join(fixture.product, 'delete.txt')));
  await assert.rejects(fs.access(path.join(fixture.product, 'rename.txt')));
});

test('restores an owned directory and removes an intentionally absent owned path', async t => {
  const fixture = await createFixture(t);
  await synchronize(fixture.options);

  assert.equal(await fs.readFile(path.join(fixture.product, 'owned', 'custom.txt'), 'utf8'), 'product owned\n');
  await assert.rejects(fs.access(path.join(fixture.product, 'owned', 'upstream.txt')));
  await assert.rejects(fs.access(path.join(fixture.product, 'absent-owned.txt')));
});

test('replays a source patch after the upstream snapshot is staged', async t => {
  const fixture = await createFixture(t);
  await synchronize({ ...fixture.options, patches: [fixture.successfulPatch] });

  assert.equal(
    (await fs.readFile(path.join(fixture.product, 'keep.txt'), 'utf8')).replaceAll('\r\n', '\n'),
    'patched target\n',
  );
});

test('applies patches when repositoryRoot is itself a parent Git repository', async t => {
  const fixture = await createFixture(t);
  await git(fixture.root, ['init']);
  await synchronize({ ...fixture.options, patches: [fixture.successfulPatch] });

  assert.equal(
    (await fs.readFile(path.join(fixture.product, 'keep.txt'), 'utf8')).replaceAll('\r\n', '\n'),
    'patched target\n',
  );
});

test('resolves a non-default target branch to an exact fetched commit', async t => {
  const fixture = await createFixture(t);
  await git(fixture.repository, ['checkout', '-b', 'feature', fixture.target]);
  await writeFile(path.join(fixture.repository, 'feature-only.txt'), 'feature branch\n');
  await git(fixture.repository, ['add', 'feature-only.txt']);
  await git(fixture.repository, ['commit', '-m', 'feature-only']);
  const featureTarget = await gitOutput(fixture.repository, ['rev-parse', 'HEAD']);
  const result = await synchronize({ ...fixture.options, target: 'feature' });
  assert.equal(result.target, featureTarget);
  assert.equal(
    await fs.readFile(path.join(fixture.product, 'feature-only.txt'), 'utf8').then(value => value.replaceAll('\r\n', '\n')),
    'feature branch\n',
  );
});

test('does not modify the product when a patch conflicts', async t => {
  const fixture = await createFixture(t);
  const before = await treeDigest(fixture.product);
  await assert.rejects(
    synchronize({ ...fixture.options, patches: [fixture.conflictingPatch] }),
    /patch preflight failed/,
  );
  assert.equal(await treeDigest(fixture.product), before);
});

test('rejects a target commit that is not a descendant of the baseline', async t => {
  const fixture = await createFixture(t);
  await git(fixture.repository, ['checkout', '--orphan', 'unrelated']);
  await git(fixture.repository, ['rm', '-rf', '.']);
  await writeFile(path.join(fixture.repository, 'unrelated.txt'), 'unrelated\n');
  await git(fixture.repository, ['add', '.']);
  await git(fixture.repository, ['commit', '-m', 'unrelated']);
  const unrelated = await gitOutput(fixture.repository, ['rev-parse', 'HEAD']);

  await assert.rejects(
    synchronize({ ...fixture.options, target: unrelated }),
    /not a descendant|ancestry/i,
  );
});

test('cleans temporary staging data after an injected verifier failure', async t => {
  const fixture = await createFixture(t);
  await assert.rejects(
    synchronize({
      ...fixture.options,
      verifier: async () => {
        throw new Error('injected verifier failure');
      },
    }),
    /injected verifier failure/,
  );
  assert.deepEqual(await fs.readdir(fixture.tempRoot), []);
});

test('does not touch the destination until staging and verification succeed', async t => {
  const fixture = await createFixture(t);
  const before = await treeDigest(fixture.product);
  let observedDuringVerification;
  await synchronize({
    ...fixture.options,
    verifier: async staged => {
      observedDuringVerification = await treeDigest(fixture.product);
      await assert.rejects(fs.access(path.join(staged, '.git')));
    },
  });
  assert.equal(observedDuringVerification, before);
  assert.notEqual(await treeDigest(fixture.product), before);
});

test('restores the old destination when the final replacement rename fails', async t => {
  const fixture = await createFixture(t);
  const staged = path.join(fixture.root, 'staged-app');
  await fs.mkdir(staged, { recursive: true });
  await writeFile(path.join(staged, 'new.txt'), 'staged\n');
  const before = await treeDigest(fixture.product);
  let renameCount = 0;
  const rename = async (source, destination) => {
    renameCount += 1;
    if (renameCount === 2) {
      throw new Error('injected final rename failure');
    }
    return fs.rename(source, destination);
  };

  await assert.rejects(
    atomicReplace(fixture.product, staged, { rename, repositoryRoot: fixture.root }),
    /injected final rename failure/,
  );
  assert.equal(await treeDigest(fixture.product), before);
});

test('retries transient final replacement rename failures', async t => {
  const fixture = await createFixture(t);
  const staged = path.join(fixture.root, 'staged-app');
  await fs.mkdir(staged, { recursive: true });
  await writeFile(path.join(staged, 'new.txt'), 'staged\n');
  let renameCount = 0;
  const rename = async (source, destination) => {
    renameCount += 1;
    if (renameCount === 2) {
      const error = new Error('injected transient rename lock');
      error.code = 'EPERM';
      throw error;
    }
    return fs.rename(source, destination);
  };

  await atomicReplace(fixture.product, staged, {
    rename,
    repositoryRoot: fixture.root,
    renameRetries: 1,
    renameRetryDelayMs: 1,
  });
  assert.equal(renameCount, 3);
  assert.equal(await fs.readFile(path.join(fixture.product, 'new.txt'), 'utf8'), 'staged\n');
});

test('reports replacement and restore failures with the backup path', async t => {
  const fixture = await createFixture(t);
  const staged = path.join(fixture.root, 'staged-app');
  await fs.mkdir(staged, { recursive: true });
  await writeFile(path.join(staged, 'new.txt'), 'staged\n');
  let renameCount = 0;
  const rename = async (source, destination) => {
    renameCount += 1;
    if (renameCount >= 2) {
      throw new Error(`injected rename failure ${renameCount}`);
    }
    return fs.rename(source, destination);
  };

  await assert.rejects(
    atomicReplace(fixture.product, staged, { rename, repositoryRoot: fixture.root }),
    error => {
      assert.equal(error.constructor, AggregateError);
      assert.match(error.message, /backup/i);
      assert.match(error.message, /app-backup-/);
      assert.ok(error.errors.some(entry => /injected rename failure/.test(entry.message)));
      return true;
    },
  );
});

test('rejects replacement targets that are not an app directory', async t => {
  const fixture = await createFixture(t);
  const unsafeProduct = path.join(fixture.root, 'product');
  await fs.rename(fixture.product, unsafeProduct);
  await assert.rejects(
    synchronize({ ...fixture.options, product: unsafeProduct }),
    /app directory|destination/i,
  );
});

test('rejects an app directory outside the declared repository root', async t => {
  const fixture = await createFixture(t);
  const unsafeProduct = path.join(fixture.root, 'evil', 'app');
  await fs.mkdir(unsafeProduct, { recursive: true });
  await assert.rejects(
    synchronize({ ...fixture.options, product: unsafeProduct }),
    /repository root|app directory|destination/i,
  );
});

test('rejects symlinked repository roots and staging roots', async t => {
  const fixture = await createFixture(t);
  const outsideRoot = path.join(fixture.root, 'outside-root');
  const linkedRoot = path.join(fixture.root, 'linked-root');
  await fs.mkdir(path.join(outsideRoot, 'app'), { recursive: true });
  await fs.cp(fixture.product, path.join(outsideRoot, 'app'), { recursive: true });
  if (!(await createSymlinkOrSkip(t, outsideRoot, linkedRoot, process.platform === 'win32' ? 'junction' : undefined))) {
    return;
  }
  await assert.rejects(
    synchronize({
      ...fixture.options,
      product: path.join(linkedRoot, 'app'),
      repositoryRoot: linkedRoot,
    }),
    /symlink|symbolic|repository root|destination/i,
  );

  const stagingOutside = path.join(fixture.root, 'staging-outside');
  const stagingLink = path.join(fixture.root, 'staging-link');
  await fs.mkdir(stagingOutside, { recursive: true });
  if (!(await createSymlinkOrSkip(t, stagingOutside, stagingLink, process.platform === 'win32' ? 'junction' : undefined))) {
    return;
  }
  await assert.rejects(
    synchronize({ ...fixture.options, tempRoot: stagingLink }),
    /symlink|symbolic|staging root/i,
  );
});

test('rejects product and staging paths that traverse symlink ancestors', async t => {
  const fixture = await createFixture(t);
  const outside = path.join(fixture.root, 'outside');
  await fs.mkdir(outside, { recursive: true });
  const outsideVictim = path.join(outside, 'victim.txt');
  await writeFile(outsideVictim, 'outside original\n');

  const staged = path.join(fixture.root, 'staged');
  await fs.mkdir(staged, { recursive: true });
  await writeFile(path.join(fixture.product, 'owned', 'victim.txt'), 'product victim\n');
  if (!(await createSymlinkOrSkip(t, outside, path.join(staged, 'owned'), process.platform === 'win32' ? 'junction' : undefined))) {
    return;
  }
  await assert.rejects(
    restoreOwnedPaths(fixture.product, staged, ['owned/victim.txt']),
    /symlink|symbolic|unsafe/i,
  );
  assert.equal(await fs.readFile(outsideVictim, 'utf8'), 'outside original\n');

  await fs.rm(path.join(staged, 'owned'), { recursive: true, force: true });
  await fs.rm(path.join(fixture.product, 'owned'), { recursive: true, force: true });
  if (!(await createSymlinkOrSkip(t, outside, path.join(fixture.product, 'owned'), process.platform === 'win32' ? 'junction' : undefined))) {
    return;
  }
  await fs.mkdir(path.join(staged, 'owned'), { recursive: true });
  await assert.rejects(
    restoreOwnedPaths(fixture.product, staged, ['owned/victim.txt']),
    /symlink|symbolic|unsafe/i,
  );
  assert.equal(await fs.readFile(outsideVictim, 'utf8'), 'outside original\n');
});

test('rejects Git repository and target refs that begin with options', async t => {
  const fixture = await createFixture(t);
  await assert.rejects(
    synchronize({
      ...fixture.options,
      source: { ...fixture.options.source, repository: '--upload-pack=echo' },
    }),
    error => error instanceof TypeError && /repository/i.test(error.message),
  );
  await assert.rejects(
    synchronize({ ...fixture.options, target: '--upload-pack=echo' }),
    error => error instanceof TypeError && /target|ref/i.test(error.message),
  );
});

test('surfaces cleanup failures together with the synchronization failure', async t => {
  const fixture = await createFixture(t);
  await assert.rejects(
    synchronize({
      ...fixture.options,
      verifier: async () => {
        throw new Error('injected verifier failure');
      },
      cleanup: async () => {
        throw new Error('injected cleanup failure');
      },
    }),
    error => {
      assert.equal(error.constructor, AggregateError);
      assert.ok(error.errors.some(entry => /injected verifier failure/.test(entry.message)));
      assert.ok(error.errors.some(entry => /injected cleanup failure/.test(entry.message)));
      return true;
    },
  );
});

test('generates binary-capable diffs and compares tracked working trees', async t => {
  const fixture = await createFixture(t);
  const diff = await generateBinaryDiff(fixture.repository, {
    from: fixture.baseline,
    to: fixture.target,
  });
  assert.match(diff, /GIT binary patch/);
  assert.match(diff, /binary\.dat/);

  const mirror = path.join(fixture.root, 'mirror');
  await cloneRepository(fixture.repository, mirror);
  await git(mirror, ['config', 'core.autocrlf', 'false']);
  await checkoutDetached(mirror, fixture.target);
  assert.equal((await compareTrackedTrees(fixture.repository, mirror)).equal, true);
  await writeFile(path.join(mirror, 'keep.txt'), 'working tree drift\n');
  const drift = await compareTrackedTrees(fixture.repository, mirror);
  assert.deepEqual(drift.modified, ['keep.txt']);
});

test('rejects option and revision-expression inputs to ancestry wrappers', async t => {
  const fixture = await createFixture(t);
  await assert.rejects(
    isAncestor(fixture.repository, '--fork-point', fixture.target),
    error => error instanceof TypeError && /ref/i.test(error.message),
  );
  await assert.rejects(
    assertAncestor(fixture.repository, `${fixture.baseline}~1`, fixture.target),
    error => error instanceof TypeError && /ref/i.test(error.message),
  );
});

test('rejects owned paths that normalize to the product root', async t => {
  const fixture = await createFixture(t);
  await assert.rejects(
    synchronize({ ...fixture.options, ownedPaths: ['owned/..'] }),
    /owned path|stay inside app/i,
  );
});
