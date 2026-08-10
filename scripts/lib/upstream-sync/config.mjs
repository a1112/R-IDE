import fs from 'node:fs';
import path from 'node:path';

const SOURCE_FIELDS = ['repository', 'branch', 'commit'];
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sourceError(message) {
  return new TypeError(`Invalid upstream source metadata: ${message}`);
}

/**
 * Validate and normalize the pinned upstream source metadata.
 *
 * The repository may be a URL or a local Git path (the latter is useful for
 * network-free fixture tests), but all three fields must be non-empty strings.
 * Commit IDs are deliberately required to be full object IDs so a sync cannot
 * silently move when a short prefix becomes ambiguous.
 */
export function validateSource(value) {
  if (!isRecord(value)) {
    throw sourceError('expected an object');
  }

  for (const field of SOURCE_FIELDS) {
    if (!Object.hasOwn(value, field)) {
      throw sourceError(`missing ${field}`);
    }
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw sourceError(`${field} must be a non-empty string`);
    }
    if (value[field] !== value[field].trim()) {
      throw sourceError(`${field} must not have surrounding whitespace`);
    }
    if (/\0/.test(value[field])) {
      throw sourceError(`${field} must not contain NUL characters`);
    }
  }

  const repository = value.repository;
  if (/\s/.test(repository)) {
    throw sourceError('repository must not contain whitespace');
  }

  const branch = value.branch;
  // Keep branch validation intentionally close to Git's ref rules while still
  // allowing ordinary names such as master, release/1.2, and feature/foo.
  if (
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    /[~^:?*\[\\\x00-\x20]/.test(branch)
  ) {
    throw sourceError('branch is not a valid Git ref');
  }

  if (!COMMIT_PATTERN.test(value.commit)) {
    throw sourceError('commit must be a 40-character hexadecimal object ID');
  }

  const unknownFields = Object.keys(value).filter(field => !SOURCE_FIELDS.includes(field));
  if (unknownFields.length > 0) {
    throw sourceError(`unknown field(s): ${unknownFields.join(', ')}`);
  }

  return {
    repository,
    branch,
    commit: value.commit,
  };
}

function pathError(entry, message = 'must stay inside app/') {
  return new TypeError(`Invalid owned path "${entry}": ${message}`);
}

function isAbsoluteOwnedPath(value) {
  // POSIX absolute and UNC paths are absolute after converting separators.
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return true;
  }
  // A drive-prefixed path is not always absolute according to win32.isAbsolute
  // (for example C:foo), but it is never a valid POSIX-relative ownership path.
  return /^[A-Za-z]:/.test(value);
}

function stripInlineComment(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trim();
    }
  }
  return value;
}

/**
 * Parse the POSIX-style ownership manifest.
 *
 * Entries are relative to app/. A trailing slash (or backslash) is retained
 * as the directory marker; all other separator and dot-segment normalization
 * is performed using POSIX rules so manifests behave identically on Windows
 * and Unix hosts.
 */
export function parseOwnedPaths(contents) {
  if (typeof contents !== 'string') {
    throw new TypeError('Owned paths must be provided as text');
  }

  const result = [];
  const seen = new Set();
  const lines = contents.split(/\r?\n/);

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const original = lines[lineNumber];
    let entry = original.trim();
    if (entry.length === 0 || entry.startsWith('#')) {
      continue;
    }

    entry = stripInlineComment(entry);
    if (entry.length === 0) {
      continue;
    }
    if (/\0/.test(entry)) {
      throw pathError(entry, 'must not contain NUL characters');
    }

    const directory = entry.endsWith('/') || entry.endsWith('\\');
    const posixEntry = entry.replaceAll('\\', '/');
    if (isAbsoluteOwnedPath(posixEntry)) {
      throw pathError(entry);
    }

    const segments = posixEntry.split('/');
    if (segments.some(segment => segment === '..')) {
      throw pathError(entry);
    }

    let normalized = path.posix.normalize(posixEntry);
    // normalize('./foo') leaves the leading './' in some Node versions.
    normalized = normalized.replace(/^\.\//, '');
    normalized = normalized.replace(/^\/+/u, '');
    normalized = normalized.replace(/\/{2,}/gu, '/');

    if (normalized === '' || normalized === '.') {
      throw pathError(entry, 'must name a path inside app/');
    }

    // Remove the directory marker produced by normalize before adding one
    // canonical marker below. This makes foo and foo/ duplicate entries.
    normalized = normalized.replace(/\/+$/u, '');
    if (normalized === '' || normalized === '..' || normalized.startsWith('../')) {
      throw pathError(entry);
    }

    const key = normalized;
    if (seen.has(key)) {
      throw pathError(entry, `duplicate owned path "${normalized}"`);
    }
    seen.add(key);
    result.push(directory ? `${normalized}/` : normalized);
  }

  return result;
}

/**
 * Load both synchronization manifests from a repository root.
 *
 * This is synchronous by design: configuration is read once at CLI startup,
 * and a synchronous failure keeps malformed metadata from being used by any
 * subsequent asynchronous Git work. Callers may still `await` the return
 * value when composing it with asynchronous setup code.
 */
export function loadSourceConfig(repositoryRoot = process.cwd()) {
  if (typeof repositoryRoot !== 'string' || repositoryRoot.length === 0) {
    throw new TypeError('Repository root must be a non-empty path');
  }

  const root = path.resolve(repositoryRoot);
  const upstreamDirectory = path.join(root, '.upstream');
  const sourcePath = path.join(upstreamDirectory, 'source.json');
  const ownedPathsPath = path.join(upstreamDirectory, 'owned-paths.txt');

  let sourceContents;
  try {
    sourceContents = fs.readFileSync(sourcePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read upstream source metadata at ${sourcePath}: ${error.message}`, {
      cause: error,
    });
  }

  let source;
  try {
    source = JSON.parse(sourceContents);
  } catch (error) {
    throw new Error(`Unable to parse upstream source metadata at ${sourcePath}: ${error.message}`, {
      cause: error,
    });
  }

  let ownedPathsContents;
  try {
    ownedPathsContents = fs.readFileSync(ownedPathsPath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read owned paths at ${ownedPathsPath}: ${error.message}`, {
      cause: error,
    });
  }

  return {
    source: validateSource(source),
    ownedPaths: parseOwnedPaths(ownedPathsContents),
  };
}

