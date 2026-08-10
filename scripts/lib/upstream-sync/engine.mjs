import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { applyPatch, applyPatchCheck, assertAncestor, cloneRepository, fetchRepository, resolveCommit, checkoutDetached } from './git.mjs';
import { copyPath, pathExists, removePath, resolveWithin } from './filesystem.mjs';

function assertProductDirectory(product) {
  if (typeof product !== 'string' || product.length === 0) {
    throw new TypeError('A product destination is required');
  }
  const resolved = path.resolve(product);
  // The synchronizer is intentionally scoped to the repository's app/ tree.
  // This guards callers against accidentally replacing a workspace root or a
  // similarly named arbitrary directory.
  if (path.basename(resolved) !== 'app') {
    throw new TypeError(`Refusing to replace destination outside an app directory: ${resolved}`);
  }
  return resolved;
}

function isWithin(parent, candidate) {
  const resolvedParent = path.resolve(parent);
  const resolvedCandidate = path.resolve(candidate);
  const prefix = resolvedParent.endsWith(path.sep) ? resolvedParent : `${resolvedParent}${path.sep}`;
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(prefix);
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
  for (const field of ['repository', 'branch', 'commit']) {
    if (typeof source[field] !== 'string' || source[field].length === 0) {
      throw new TypeError(`Upstream source is missing ${field}`);
    }
  }
  return source;
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

async function atomicReplace(destination, staged) {
  const parent = path.dirname(destination);
  const backup = path.join(parent, `.app-backup-${crypto.randomBytes(12).toString('hex')}`);
  let movedOld = false;
  let installed = false;
  try {
    await fs.rename(destination, backup);
    movedOld = true;
    await fs.rename(staged, destination);
    installed = true;
    await removePath(backup);
  } catch (error) {
    // If installation partially succeeded, remove it before restoring the old
    // tree. If it did not, the staged directory remains under temporaryRoot
    // and the outer finally block removes it.
    if (installed) {
      await removePath(destination).catch(() => {});
    }
    if (movedOld && !(await pathExists(destination))) {
      await fs.rename(backup, destination).catch(() => {});
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
  );
  const source = sourceFromOptions(options);
  const targetRef = options.target ?? options.targetCommit ?? source.branch;
  if (typeof targetRef !== 'string' || targetRef.length === 0) {
    throw new TypeError('A target branch or commit is required');
  }
  // Keep the default staging root beside app/ so the final directory renames
  // stay on one volume (Windows rename cannot atomically move across drives).
  // Callers may provide a different explicit root when they know it shares the
  // destination volume.
  const temporaryBase = path.resolve(options.tempRoot ?? path.dirname(product));
  if (isWithin(product, temporaryBase)) {
    throw new TypeError(`Staging root must not be inside the product directory: ${temporaryBase}`);
  }
  const productStat = await fs.lstat(product).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (productStat && !productStat.isDirectory()) {
    throw new TypeError(`Product destination must be a directory: ${product}`);
  }
  if (!productStat) {
    throw new TypeError(`Product destination does not exist: ${product}`);
  }
  await fs.mkdir(temporaryBase, { recursive: true });
  const temporaryRoot = await fs.mkdtemp(path.join(temporaryBase, 'ride-upstream-sync-'));
  const checkout = path.join(temporaryRoot, 'checkout');
  let target;
  let baseline;
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

    // The checkout is now an ordinary product tree. Removing Git metadata
    // before ownership/patch operations prevents repository internals from
    // accidentally becoming product content.
    await removePath(path.join(checkout, '.git'));
    await restoreOwnedPaths(product, checkout, options.ownedPaths ?? []);
    const appliedPatches = await applyPatches(checkout, options.patches ?? [], temporaryRoot);

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
      await atomicReplace(product, checkout);
    } else {
      await replace(product, checkout, { baseline, target });
    }
    return { product, baseline, target, appliedPatches };
  } finally {
    await removePath(temporaryRoot).catch(() => {});
  }
}

export { atomicReplace, restoreOwnedPaths };
