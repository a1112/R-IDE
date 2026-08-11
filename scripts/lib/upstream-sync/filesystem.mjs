import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
}

/**
 * Reject paths that traverse a symbolic link before reaching their final
 * entry. The final entry itself is allowed to be a link so callers can remove
 * or copy a link without following it; all parent components must be ordinary
 * directories. Set `includeTarget` when the target itself must also be a real
 * directory (for example a staging root or product root).
 */
export async function assertNoSymlinkAncestors(target, { includeTarget = false } = {}) {
  if (typeof target !== 'string' || target.length === 0) {
    throw new TypeError('A path is required for symlink validation');
  }
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return;
      }
      throw error;
    }
    const isTarget = index === segments.length - 1;
    if (stat.isSymbolicLink() && (includeTarget || !isTarget)) {
      throw new TypeError(`Refusing path through symbolic link: ${current}`);
    }
    if (!isTarget && !stat.isDirectory()) {
      throw new TypeError(`Path ancestor is not a directory: ${current}`);
    }
  }
}

/** Remove a path after callers have resolved and validated its scope. */
export async function removePath(target) {
  await assertNoSymlinkAncestors(target);
  await fs.rm(target, { recursive: true, force: true });
}

/**
 * Resolve a POSIX-style relative path beneath an explicit root. This check is
 * lexical by design; ownership paths are controlled repository metadata and
 * are copied as links rather than followed when they are encountered.
 */
export function resolveWithin(root, relativePath) {
  if (typeof root !== 'string' || typeof relativePath !== 'string') {
    throw new TypeError('A root and relative path are required');
  }
  const rootPath = path.resolve(root);
  const normalizedRelative = relativePath.replaceAll('/', path.sep).replaceAll('\\', path.sep);
  const candidate = path.resolve(rootPath, normalizedRelative);
  const prefix = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
  if (candidate !== rootPath && !candidate.startsWith(prefix)) {
    throw new TypeError(`Path escapes its root: ${relativePath}`);
  }
  return candidate;
}

async function copyEntry(source, destination) {
  const stat = await fs.lstat(source);
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const name of await fs.readdir(source)) {
      await copyEntry(path.join(source, name), path.join(destination, name));
    }
    // Preserve executable directory bits where the platform supports them.
    try {
      await fs.chmod(destination, stat.mode & 0o7777);
    } catch {
      // chmod is not available for some Windows filesystems; content remains
      // correct and Git records executable bits only on platforms that support
      // them.
    }
    return;
  }
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(source);
    if (process.platform === 'win32') {
      let linkType = 'file';
      try {
        linkType = (await fs.stat(source)).isDirectory() ? 'junction' : 'file';
      } catch {
        // Keep a file link for broken links; Git-owned symlinks are uncommon
        // on Windows but preserving the link itself is safer than following it.
      }
      await fs.symlink(target, destination, linkType);
    } else {
      await fs.symlink(target, destination);
    }
    return;
  }
  await fs.copyFile(source, destination);
  try {
    await fs.chmod(destination, stat.mode & 0o7777);
  } catch {
    // See the directory chmod note above.
  }
}

/**
 * Copy one file, directory, or symlink and replace any existing destination.
 * A missing source is represented by `false`, which lets ownership manifests
 * express intentionally absent paths without a special sentinel file.
 */
export async function copyPath(source, destination) {
  await assertNoSymlinkAncestors(source);
  await assertNoSymlinkAncestors(destination);
  if (!(await pathExists(source))) {
    return false;
  }
  await removePath(destination);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await copyEntry(source, destination);
  return true;
}

async function collectTree(root, current, relative, entries) {
  const names = (await fs.readdir(current, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of names) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childPath = path.join(current, entry.name);
    const stat = await fs.lstat(childPath);
    if (stat.isDirectory()) {
      entries.push({ path: childRelative, type: 'directory', mode: stat.mode & 0o7777 });
      await collectTree(root, childPath, childRelative, entries);
    } else if (stat.isSymbolicLink()) {
      entries.push({
        path: childRelative,
        type: 'symlink',
        mode: stat.mode & 0o7777,
        target: await fs.readlink(childPath),
      });
    } else {
      const data = await fs.readFile(childPath);
      entries.push({
        path: childRelative,
        type: 'file',
        mode: stat.mode & 0o7777,
        digest: crypto.createHash('sha256').update(data).digest('hex'),
      });
    }
  }
}

/** Return a deterministic, content-based representation of a filesystem tree. */
export async function treeEntries(root) {
  const entries = [];
  await collectTree(root, root, '', entries);
  return entries;
}

export async function treeDigest(root) {
  const entries = await treeEntries(root);
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export async function copyDirectory(source, destination) {
  if (!(await pathExists(source))) {
    throw new Error(`Directory does not exist: ${source}`);
  }
  const stat = await fs.lstat(source);
  if (!stat.isDirectory()) {
    throw new Error(`Expected a directory: ${source}`);
  }
  await removePath(destination);
  await fs.mkdir(destination, { recursive: true });
  for (const name of await fs.readdir(source)) {
    await copyEntry(path.join(source, name), path.join(destination, name));
  }
}
