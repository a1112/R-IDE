import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { runCommand } from './command.mjs';

async function digestFile(file) {
  const hash = crypto.createHash('sha256');
  const contents = await fs.readFile(file);
  // Git may materialize text files with platform line endings during a
  // temporary clone. Treat those as equivalent while retaining byte fidelity
  // for binary files.
  hash.update(contents.includes(0) ? contents : contents.toString('utf8').replaceAll('\r\n', '\n'));
  return hash.digest('hex');
}

async function snapshot(root, paths = undefined) {
  const result = new Map();
  const visit = async (current, relative = '') => {
    let children;
    try {
      children = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (child.name === '.git') continue;
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      const childPath = path.join(current, child.name);
      if (child.isDirectory()) {
        await visit(childPath, childRelative);
      } else if (child.isSymbolicLink()) {
        result.set(childRelative, { type: 'link', value: await fs.readlink(childPath) });
      } else if (child.isFile()) {
        result.set(childRelative, { type: 'file', value: await digestFile(childPath) });
      }
    }
  };
  if (paths === undefined) {
    await visit(root);
  } else {
    for (const relative of paths) {
      const normalized = relative.replaceAll('\\', '/');
      const file = path.join(root, ...normalized.split('/'));
      try {
        const stat = await fs.lstat(file);
        if (stat.isDirectory()) await visit(file, normalized);
        else if (stat.isSymbolicLink()) result.set(normalized, { type: 'link', value: await fs.readlink(file) });
        else if (stat.isFile()) result.set(normalized, { type: 'file', value: await digestFile(file) });
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      }
    }
  }
  return result;
}

export async function trackedProductPaths(repositoryRoot) {
  const { stdout } = await runCommand('git', ['-C', repositoryRoot, 'ls-files', '-z', '--', 'app'], { cwd: repositoryRoot });
  return stdout.split('\0').filter(Boolean).map(entry => entry.replace(/^app\//u, ''));
}

export async function compareProductTrees(repositoryRoot, product, staged) {
  const tracked = await trackedProductPaths(repositoryRoot);
  const right = await snapshot(staged);
  // Include newly staged paths in the product side even when the caller has
  // not yet added them to its Git index. This makes a second identical sync a
  // true no-op while still excluding ignored build output and dependencies.
  const left = await snapshot(product, [...new Set([...tracked, ...right.keys()])]);
  const added = [];
  const removed = [];
  const modified = [];
  for (const [relative, value] of left) {
    if (!right.has(relative)) removed.push(relative);
    else if (JSON.stringify(value) !== JSON.stringify(right.get(relative))) modified.push(relative);
  }
  for (const relative of right.keys()) if (!left.has(relative)) added.push(relative);
  added.sort(); removed.sort(); modified.sort();
  let renamed = 0;
  const usedRemoved = new Set();
  const usedAdded = new Set();
  for (const addedPath of added) {
    const addedValue = right.get(addedPath);
    const oldIndex = removed.findIndex((removedPath, index) => !usedRemoved.has(index) && JSON.stringify(left.get(removedPath)) === JSON.stringify(addedValue));
    if (oldIndex >= 0) {
      usedRemoved.add(oldIndex); usedAdded.add(addedPath); renamed += 1;
    }
  }
  return {
    added: added.filter(entry => !usedAdded.has(entry)),
    modified,
    deleted: removed.filter((_, index) => !usedRemoved.has(index)),
    renamed,
  };
}

export function compareUrl(repository, previousCommit, targetCommit) {
  if (!/^https?:\/\//iu.test(repository)) return null;
  const base = repository.replace(/\.git$/iu, '').replace(/\/$/u, '');
  return `${base}/compare/${previousCommit}...${targetCommit}`;
}

export function makeReport({ changed, previousCommit, targetCommit, diff = {}, ownedPaths = [], patches = [], repository }) {
  return {
    changed: Boolean(changed),
    previousCommit,
    targetCommit,
    counts: {
      added: diff.added?.length ?? 0,
      modified: diff.modified?.length ?? 0,
      deleted: diff.deleted?.length ?? 0,
      renamed: diff.renamed ?? 0,
    },
    ownedPaths: [...ownedPaths],
    patches: [...patches],
    compareUrl: compareUrl(repository, previousCommit, targetCommit),
  };
}
