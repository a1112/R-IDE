import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { validateSource } from './config.mjs';
import { applyPatch, applyPatchCheck, assertAncestor, cloneRepository, fetchRepository, resolveCommit, checkoutDetached, validateGitRef } from './git.mjs';
import { assertNoSymlinkAncestors, copyPath, pathExists, removePath, resolveWithin } from './filesystem.mjs';

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function assertProductDirectory(product, repositoryRoot) {
  if (typeof product !== 'string' || product.length === 0) {
    throw new TypeError('A product destination is required');
  }
  if (typeof repositoryRoot !== 'string' || repositoryRoot.length === 0) {
    throw new TypeError('A repositoryRoot is required to guard the app destination');
  }
  const resolved = path.resolve(product);
  const expected = path.join(path.resolve(repositoryRoot), 'app');
  if (!samePath(resolved, expected)) {
    throw new TypeError(`Refusing to replace destination outside the repository app directory: ${resolved}`);
  }
  return resolved;
}

function isWithin(parent, candidate) {
  const resolvedParent = path.resolve(parent);
  const resolvedCandidate = path.resolve(candidate);
  const prefix = resolvedParent.endsWith(path.sep) ? resolvedParent : `${resolvedParent}${path.sep}`;
  if (samePath(resolvedCandidate, resolvedParent)) {
    return true;
  }
  return process.platform === 'win32'
    ? resolvedCandidate.toLowerCase().startsWith(prefix.toLowerCase())
    : resolvedCandidate.startsWith(prefix);
}

function sourceFromOptions(options) {
  const source = options.source ?? {
    repository: options.repository,
    branch: options.branch,
    commit: options.commit,
  };
  if (source === null || typeof source !== 'object') {
    throw new TypeError('Upstream source metadata must be an object');
  }
  try {
    return validateSource(source);
  } catch (error) {
    throw new TypeError(`Invalid upstream source: ${error.message}`, { cause: error });
  }
}

function normalizeOwnedPath(entry) {
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new TypeError('Owned paths must be non-empty strings');
  }
  const normalized = entry.replace(/[\\/]$/u, '').replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split('/').some(segment => segment === '..') ||
    /\0/u.test(normalized)
  ) {
    throw new TypeError(`Owned path must stay inside app/: ${entry}`);
  }
  return normalized;
}

async function normalizePatches(patches, temporaryRoot) {
  if (patches === undefined || patches === null) return [];
  if (!Array.isArray(patches)) {
    throw new TypeError('Patches must be an array');
  }
  const patchRoot = path.join(temporaryRoot, 'patches');
  await fs.mkdir(patchRoot, { recursive: true });
  const entries = [];
  for (let index = 0; index < patches.length; index += 1) {
    const patch = patches[index];
    let label;
    let patchPath;
    let contents;
    if (typeof patch === 'string') {
      if (await pathExists(patch)) {
        label = patch.replaceAll('\\', '/');
        patchPath = path.resolve(patch);
      } else {
        label = `${String(index).padStart(8, '0')}.patch`;
        contents = patch;
      }
    } else if (patch && typeof patch === 'object' && typeof patch.path === 'string') {
      label = patch.name ?? patch.path.replaceAll('\\', '/');
      patchPath = path.resolve(patch.path);
    } else if (
      patch &&
      typeof patch === 'object' &&
      (typeof patch.contents === 'string' || Buffer.isBuffer(patch.contents))
    ) {
      label = patch.name ?? `${String(index).padStart(8, '0')}.patch`;
      contents = patch.contents;
    } else if (Buffer.isBuffer(patch) || patch instanceof Uint8Array) {
      label = `${String(index).padStart(8, '0')}.patch`;
      contents = patch;
    } else {
      throw new TypeError('Each patch must be text, a patch path, or an object containing path/contents');
    }
    if (patchPath === undefined) {
      patchPath = path.join(patchRoot, `${String(index).padStart(8, '0')}.patch`);
      await fs.writeFile(patchPath, contents, 'utf8');
    }
    entries.push({ label, patchPath, index });
  }
  entries.sort((left, right) => {
    if (left.label < right.label) return -1;
    if (left.label > right.label) return 1;
    return left.index - right.index;
  });
  return entries;
}

async function restoreOwnedPaths(product, staged, ownedPaths) {
  for (const entry of ownedPaths ?? []) {
    const relativePath = normalizeOwnedPath(entry);
    // Resolve both sides through the same path guard. This keeps malformed
    // ownership manifests from escaping either the product or checkout root.
    const source = resolveWithin(product, relativePath);
    const destination = resolveWithin(staged, relativePath);
    await assertNoSymlinkAncestors(source);
    await assertNoSymlinkAncestors(destination);
    if (await pathExists(source)) {
      await copyPath(source, destination);
    } else {
      await removePath(destination);
    }
  }
}

async function applyPatches(staged, patches, temporaryRoot) {
  const entries = await normalizePatches(patches, temporaryRoot);
  for (const entry of entries) {
    try {
      await applyPatchCheck(staged, entry.patchPath);
    } catch (error) {
      const detail = error?.stderr?.trim();
      throw new Error(
        `patch preflight failed for ${entry.label}${detail ? `: ${detail}` : ''}`,
        { cause: error },
      );
    }
    try {
      await applyPatch(staged, entry.patchPath);
    } catch (error) {
      const detail = error?.stderr?.trim();
      throw new Error(
        `patch apply failed for ${entry.label}${detail ? `: ${detail}` : ''}`,
        { cause: error },
      );
    }
  }
  return entries.map(entry => entry.label);
}

async function assertRealProduct(product, repositoryRoot) {
  await assertNoSymlinkAncestors(repositoryRoot, { includeTarget: true });
  await assertNoSymlinkAncestors(product, { includeTarget: true });
  const [rootStat, productStat] = await Promise.all([fs.lstat(repositoryRoot), fs.lstat(product)]);
  if (!rootStat.isDirectory() || productStat.isSymbolicLink() || !productStat.isDirectory()) {
    throw new TypeError(`Product destination must be a real directory under repositoryRoot: ${product}`);
  }
  const [rootReal, productReal] = await Promise.all([fs.realpath(repositoryRoot), fs.realpath(product)]);
  const expectedReal = path.join(rootReal, 'app');
  if (!samePath(productReal, expectedReal)) {
    throw new TypeError(`Product destination resolves outside repositoryRoot/app: ${product}`);
  }
  return { rootReal, productReal };
}

async function atomicReplace(
  destination,
  staged,
  { rename = (source, target) => fs.rename(source, target), repositoryRoot } = {},
) {
  if (typeof rename !== 'function') {
    throw new TypeError('atomic replacement rename must be a function');
  }
  assertProductDirectory(destination, repositoryRoot);
  await assertRealProduct(destination, repositoryRoot);
  await assertNoSymlinkAncestors(staged, { includeTarget: true });
  const stagedStat = await fs.lstat(staged);
  if (stagedStat.isSymbolicLink() || !stagedStat.isDirectory()) {
    throw new TypeError(`Staged replacement must be a real directory: ${staged}`);
  }
  const parent = path.dirname(destination);
  const backup = path.join(parent, `.app-backup-${crypto.randomBytes(12).toString('hex')}`);
  let movedOld = false;
  let installed = false;
  try {
    await rename(destination, backup);
    movedOld = true;
    await rename(staged, destination);
    installed = true;
    await removePath(backup);
  } catch (error) {
    const restoreFailures = [];
    if (installed) {
      try {
        await removePath(destination);
      } catch (restoreError) {
        restoreFailures.push(restoreError);
      }
    }
    if (movedOld) {
      let destinationExists = false;
      try {
        destinationExists = await pathExists(destination);
      } catch (restoreError) {
        restoreFailures.push(restoreError);
      }
      if (!destinationExists) {
        try {
          await rename(backup, destination);
        } catch (restoreError) {
          restoreFailures.push(restoreError);
        }
      }
    }
    if (restoreFailures.length > 0) {
      throw new AggregateError(
        [error, ...restoreFailures],
        `Atomic replacement failed; backup path: ${backup}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Reconstruct an app tree from a pinned upstream snapshot transactionally.
 * Every potentially failing operation occurs in a temporary checkout; the
 * caller's app/ directory is renamed into place only after verification passes.
 */
export async function synchronize(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('Synchronization options must be an object');
  }
  const repositoryRoot = options.repositoryRoot ?? options.root ?? options.workspaceRoot;
  const product = assertProductDirectory(
    options.product ??
      options.productDir ??
      options.productPath ??
      options.productDirectory ??
      options.app ??
      options.appDir ??
      options.appPath ??
      options.appDirectory ??
    options.destination,
    repositoryRoot,
  );
  const source = sourceFromOptions(options);
  const targetRef = options.target ?? options.targetCommit ?? source.branch;
  if (typeof targetRef !== 'string' || targetRef.length === 0) {
    throw new TypeError('A target branch or commit is required');
  }
  if (!/^[0-9a-f]{40}$/iu.test(targetRef)) {
    try {
      validateGitRef(targetRef, { allowHead: false });
    } catch (error) {
      throw new TypeError(`Invalid target ref: ${targetRef}`, { cause: error });
    }
  }
  // Keep the default staging root beside app/ so the final directory renames
  // stay on one volume (Windows rename cannot atomically move across drives).
  // Callers may provide a different explicit root when they know it shares the
  // destination volume.
  const temporaryBase = path.resolve(options.tempRoot ?? path.dirname(product));
  const { productReal } = await assertRealProduct(product, repositoryRoot);
  await assertNoSymlinkAncestors(temporaryBase, { includeTarget: true });
  await fs.mkdir(temporaryBase, { recursive: true });
  await assertNoSymlinkAncestors(temporaryBase, { includeTarget: true });
  const temporaryBaseReal = await fs.realpath(temporaryBase);
  if (isWithin(productReal, temporaryBaseReal)) {
    throw new TypeError(`Staging root must not resolve inside the product directory: ${temporaryBase}`);
  }
  if (typeof options.cleanup !== 'undefined' && typeof options.cleanup !== 'function') {
    throw new TypeError('cleanup must be a function');
  }
  const cleanup = options.cleanup ?? removePath;
  const temporaryRoot = await fs.mkdtemp(path.join(temporaryBase, 'ride-upstream-sync-'));
  const checkout = path.join(temporaryRoot, 'checkout');
  let target;
  let baseline;
  let operationError;
  try {
    await cloneRepository(source.repository, checkout);
    // A branch may move after clone, while a full object ID is already present
    // in most clones. Fetching both forms keeps target resolution exact without
    // falling back to a moving symbolic ref.
    try {
      await fetchRepository(checkout, targetRef);
    } catch (error) {
      if (!/^[0-9a-f]{40}$/iu.test(targetRef)) {
        throw error;
      }
    }

    baseline = await resolveCommit(checkout, source.commit);
    try {
      target = await resolveCommit(checkout, targetRef);
    } catch (error) {
      // `git fetch origin branch` records the fetched tip in FETCH_HEAD and
      // updates origin/branch, but does not always create a local branch. Use
      // FETCH_HEAD as the exact fallback for that portable case.
      if (/^[0-9a-f]{40}$/iu.test(targetRef)) {
        throw error;
      }
      target = await resolveCommit(checkout, 'FETCH_HEAD');
    }
    await assertAncestor(checkout, baseline, target);
    await checkoutDetached(checkout, target);

    // Keep checkout metadata until Git-owned operations finish. If the product
    // repository itself is a parent of this temporary directory, `git apply`
    // would otherwise discover that parent .git and apply relative to the
    // wrong worktree.
    await restoreOwnedPaths(product, checkout, options.ownedPaths ?? []);
    const appliedPatches = await applyPatches(checkout, options.patches ?? [], temporaryRoot);
    // The prepared checkout is now an ordinary product tree; never expose its
    // temporary Git metadata to verification or the final replacement.
    await removePath(path.join(checkout, '.git'));

    if (options.verifier !== undefined) {
      if (typeof options.verifier !== 'function') {
        throw new TypeError('Verifier must be a function');
      }
      const verificationResult = await options.verifier(checkout, {
        product,
        baseline,
        target,
        ownedPaths: options.ownedPaths ?? [],
        patches: appliedPatches,
      });
      if (verificationResult === false) {
        throw new Error('upstream synchronization verifier returned false');
      }
    }

    // Keep the replacement seam injectable for failure-injection tests while
    // retaining the guarded atomic implementation as the default.
    const replace = options.replaceDestination ?? options.replace ?? atomicReplace;
    if (typeof replace !== 'function') {
      throw new TypeError('replaceDestination must be a function');
    }
    if (replace === atomicReplace) {
      await atomicReplace(product, checkout, { repositoryRoot });
    } else {
      await replace(product, checkout, { baseline, target });
    }
    return { product, baseline, target, appliedPatches };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await cleanup(temporaryRoot);
    } catch (cleanupError) {
      if (operationError) {
        throw new AggregateError(
          [operationError, cleanupError],
          `Synchronization and temporary cleanup both failed: ${temporaryRoot}`,
          { cause: operationError },
        );
      }
      throw cleanupError;
    }
  }
}

export { atomicReplace, restoreOwnedPaths };
