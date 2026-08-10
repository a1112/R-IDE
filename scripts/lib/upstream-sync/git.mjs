import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CommandError, runCommand } from './command.mjs';

const OBJECT_ID = /^[0-9a-f]{40}$/iu;

function requireRepository(repository) {
  if (
    typeof repository !== 'string' ||
    repository.length === 0 ||
    repository.startsWith('-') ||
    /[\0\r\n]/u.test(repository)
  ) {
    throw new TypeError('Git repository path or URL must be a non-empty string');
  }
}

export function validateGitRef(ref, { allowHead = true } = {}) {
  if (typeof ref !== 'string' || ref.length === 0 || /[\0\r\n\x00-\x20\x7f]/u.test(ref)) {
    throw new TypeError('Git ref must be a non-empty ref without whitespace or NUL characters');
  }
  if (
    ref.startsWith('-') ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.includes('//') ||
    ref.includes('..') ||
    ref.includes('@{') ||
    /[~^:?*\[\\]/u.test(ref) ||
    (!allowHead && (ref === 'HEAD' || ref === '@'))
  ) {
    throw new TypeError(`Invalid Git ref: ${ref}`);
  }
  for (const component of ref.split('/')) {
    if (
      component.length === 0 ||
      component === '.' ||
      component === '..' ||
      component.startsWith('.') ||
      component.endsWith('.') ||
      component.endsWith('.lock')
    ) {
      throw new TypeError(`Invalid Git ref: ${ref}`);
    }
  }
  return ref;
}

function requireRef(ref, options) {
  return validateGitRef(ref, options);
}

/** Clone a repository without checking out its default branch. */
export async function cloneRepository(repository, destination) {
  requireRepository(repository);
  if (typeof destination !== 'string' || destination.length === 0) {
    throw new TypeError('Git clone destination must be a non-empty path');
  }
  await runCommand('git', [
    'clone',
    '--no-checkout',
    '--no-tags',
    '--origin',
    'origin',
    '--',
    repository,
    destination,
  ]);
  return destination;
}

/** Fetch a branch, tag, or exact object from the cloned origin. */
export async function fetchRepository(repositoryPath, ref) {
  requireRef(ref, { allowHead: false });
  await runCommand('git', ['fetch', '--no-tags', 'origin', '--', ref], { cwd: repositoryPath });
}

/** Resolve a ref to an unambiguous 40-character commit ID. */
export async function resolveCommit(repositoryPath, ref) {
  requireRef(ref);
  const { stdout } = await runCommand(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    { cwd: repositoryPath },
  );
  const commit = stdout.trim();
  if (!OBJECT_ID.test(commit)) {
    throw new Error(`Git ref ${ref} did not resolve to a 40-character commit`);
  }
  return commit.toLowerCase();
}

export async function isAncestor(repositoryPath, ancestor, descendant) {
  const result = await runCommand(
    'git',
    ['merge-base', '--is-ancestor', ancestor, descendant],
    { cwd: repositoryPath },
  ).then(() => true).catch(error => {
    if (error instanceof CommandError && error.exitCode === 1) {
      return false;
    }
    throw error;
  });
  return result;
}

export async function assertAncestor(repositoryPath, ancestor, descendant) {
  if (!(await isAncestor(repositoryPath, ancestor, descendant))) {
    throw new Error(`Target commit ${descendant} is not a descendant of baseline ${ancestor}`);
  }
}

/** Check out a commit without attaching the temporary checkout to a branch. */
export async function checkoutDetached(repositoryPath, commit) {
  requireRef(commit);
  await runCommand('git', ['checkout', '--detach', '--force', '--quiet', commit], {
    cwd: repositoryPath,
  });
}

export async function applyPatchCheck(repositoryPath, patchPath) {
  await runCommand('git', ['apply', '--check', '--binary', '--whitespace=nowarn', '--', patchPath], {
    cwd: repositoryPath,
  });
}

export async function applyPatch(repositoryPath, patchPath) {
  await runCommand('git', ['apply', '--binary', '--whitespace=nowarn', '--', patchPath], {
    cwd: repositoryPath,
  });
}

/**
 * Generate a binary-capable patch. `to` may be another commit; when omitted,
 * Git compares the requested base to the current working tree.
 */
export async function generateBinaryDiff(repositoryPath, { from = 'HEAD', to } = {}) {
  requireRef(from);
  const args = ['diff', '--binary', from];
  if (to !== undefined) {
    requireRef(to);
    args.push(to);
  }
  const { stdout } = await runCommand('git', args, { cwd: repositoryPath });
  return stdout;
}

export const binaryDiff = generateBinaryDiff;

/** Return the tracked index tree as a map of POSIX paths to Git object IDs. */
export async function trackedTree(repositoryPath) {
  const { stdout } = await runCommand('git', ['ls-files', '-s', '-z'], {
    cwd: repositoryPath,
  });
  const result = new Map();
  for (const entry of stdout.split('\0')) {
    if (entry.length === 0) continue;
    const separator = entry.indexOf('\t');
    if (separator < 0) continue;
    const [mode, object, stage] = entry.slice(0, separator).split(' ');
    const relativePath = entry.slice(separator + 1).replaceAll('\\', '/');
    result.set(relativePath, { mode, object, stage });
  }
  return result;
}

function mapDifference(left, right) {
  const added = [];
  const removed = [];
  const modified = [];
  for (const [relativePath, value] of left) {
    if (!right.has(relativePath)) {
      removed.push(relativePath);
    } else if (JSON.stringify(value) !== JSON.stringify(right.get(relativePath))) {
      modified.push(relativePath);
    }
  }
  for (const relativePath of right.keys()) {
    if (!left.has(relativePath)) {
      added.push(relativePath);
    }
  }
  added.sort();
  removed.sort();
  modified.sort();
  return { equal: added.length === 0 && removed.length === 0 && modified.length === 0, added, removed, modified };
}

async function workingTree(repositoryPath) {
  const { stdout } = await runCommand('git', ['ls-files', '-z'], { cwd: repositoryPath });
  const result = new Map();
  for (const relativePath of stdout.split('\0')) {
    if (relativePath.length === 0) continue;
    const absolutePath = path.join(repositoryPath, ...relativePath.split('/'));
    try {
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        const target = Buffer.from(await fs.readlink(absolutePath));
        const header = Buffer.from(`blob ${target.length}\0`);
        result.set(relativePath, {
          mode: '120000',
          object: crypto.createHash('sha1').update(header).update(target).digest('hex'),
        });
      } else if (stat.isFile()) {
        const contents = await fs.readFile(absolutePath);
        const header = Buffer.from(`blob ${contents.length}\0`);
        result.set(relativePath, {
          mode: (stat.mode & 0o111) === 0 ? '100644' : '100755',
          object: crypto.createHash('sha1').update(header).update(contents).digest('hex'),
        });
      } else {
        result.set(relativePath, { missing: true });
      }
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        result.set(relativePath, { missing: true });
      } else {
        throw error;
      }
    }
  }
  return result;
}

export async function compareTrackedTrees(leftRepository, rightRepository) {
  const [left, right] = await Promise.all([workingTree(leftRepository), workingTree(rightRepository)]);
  return mapDifference(left, right);
}

export async function trackedTreesEqual(leftRepository, rightRepository) {
  return (await compareTrackedTrees(leftRepository, rightRepository)).equal;
}

export async function removeGitMetadata(repositoryPath) {
  await fs.rm(path.join(repositoryPath, '.git'), { recursive: true, force: true });
}

// Explicit aliases keep the small wrapper convenient for callers while
// retaining descriptive names in the implementation.
export const cloneExact = cloneRepository;
export const fetchExact = fetchRepository;
export const resolveRef = resolveCommit;
export const checkout = checkoutDetached;
export const clone = cloneRepository;
export const fetch = fetchRepository;
export const isDescendant = isAncestor;
export const generatePatch = generateBinaryDiff;
export const gitDiff = generateBinaryDiff;
export const compareTracked = compareTrackedTrees;
