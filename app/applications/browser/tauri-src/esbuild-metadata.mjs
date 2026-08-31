import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function assertWithin(root, candidate) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Esbuild output escapes browser build directory: ${candidate}`);
    }
}

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function splitNamespace(candidate) {
    const match = candidate.match(/^(node-file|file):/i);
    return match
        ? { namespace: match[0].toLowerCase(), value: candidate.slice(match[0].length) }
        : { namespace: '', value: candidate };
}

function portableSlashes(candidate) {
    return candidate.replaceAll('\\', '/');
}

function absoluteLogicalPath(candidate, baseDirectory) {
    let normalized = portableSlashes(candidate);
    if (/^\/+[A-Za-z]:\//.test(normalized)) {
        normalized = normalized.replace(/^\/+/, '');
    }
    const absolute = /^[A-Za-z]:\//.test(normalized)
        || normalized.startsWith('//')
        || normalized.startsWith('/');
    if (!absolute) {
        return undefined;
    }

    let normalizedBase = portableSlashes(baseDirectory).replace(/\/+$/, '');
    if (/^\/+[A-Za-z]:\//.test(normalizedBase)) {
        normalizedBase = normalizedBase.replace(/^\/+/, '');
    }
    const folded = normalized.toLowerCase();
    const foldedBase = normalizedBase.toLowerCase();
    if (folded === foldedBase) {
        throw new Error(`Esbuild metadata path resolves to the browser application root: ${candidate}`);
    }
    if (folded.startsWith(`${foldedBase}/`)) {
        return normalized.slice(normalizedBase.length + 1);
    }

    const segments = normalized.split('/').filter(Boolean);
    const dependencyIndex = segments.findIndex(segment => (
        segment === 'node_modules' || segment.endsWith('-node_modules')
    ));
    if (dependencyIndex >= 0 && dependencyIndex < segments.length - 1) {
        return ['node_modules', ...segments.slice(dependencyIndex + 1)].join('/');
    }
    throw new Error(`Esbuild metadata absolute path cannot be logicalized: ${candidate}`);
}

function logicalPath(candidate, { baseDirectory, key = false } = {}) {
    if (typeof candidate !== 'string') {
        return candidate;
    }
    const { namespace, value } = splitNamespace(candidate);
    const absolute = absoluteLogicalPath(value, baseDirectory);
    let logical = absolute ?? portableSlashes(value);
    if (key) {
        logical = logical.replace(/^\.\//, '');
    }
    return `${namespace}${logical}`;
}

function rewriteKeyedObject(value, rewriteKey, label) {
    const rewritten = new Map();
    for (const [source, detail] of Object.entries(value ?? {})) {
        const target = rewriteKey(source);
        if (rewritten.has(target)) {
            throw new Error(`Esbuild metadata path collision in ${label}: ${source} and ${rewritten.get(target).source} -> ${target}`);
        }
        rewritten.set(target, { source, detail });
    }
    return Object.fromEntries([...rewritten.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([target, record]) => [target, record.detail]));
}

function rewriteImports(imports, options) {
    return imports?.map(imported => ({
        ...imported,
        ...(typeof imported.path === 'string'
            ? { path: logicalPath(imported.path, options) }
            : {}),
        ...(typeof imported.original === 'string'
            ? { original: logicalPath(imported.original, options) }
            : {}),
    }));
}

export function logicalizeMetafilePaths(metafile, { baseDirectory } = {}) {
    if (!metafile || typeof metafile !== 'object'
        || !metafile.inputs || typeof metafile.inputs !== 'object'
        || !metafile.outputs || typeof metafile.outputs !== 'object'
        || typeof baseDirectory !== 'string' || !baseDirectory) {
        throw new Error('Esbuild metadata logicalization requires a metafile and base directory.');
    }
    const options = { baseDirectory };
    const inputs = rewriteKeyedObject(metafile.inputs, input => logicalPath(input, { ...options, key: true }), 'inputs');
    for (const [input, detail] of Object.entries(inputs)) {
        inputs[input] = {
            ...detail,
            ...(detail.imports ? { imports: rewriteImports(detail.imports, options) } : {}),
        };
    }
    const outputs = rewriteKeyedObject(metafile.outputs, output => logicalPath(output, { ...options, key: true }), 'outputs');
    for (const [output, detail] of Object.entries(outputs)) {
        outputs[output] = {
            ...detail,
            ...(detail.inputs ? {
                inputs: rewriteKeyedObject(
                    detail.inputs,
                    input => logicalPath(input, { ...options, key: true }),
                    `output ${output} inputs`,
                ),
            } : {}),
            ...(detail.imports ? { imports: rewriteImports(detail.imports, options) } : {}),
            ...(typeof detail.entryPoint === 'string'
                ? { entryPoint: logicalPath(detail.entryPoint, { ...options, key: true }) }
                : {}),
            ...(typeof detail.cssBundle === 'string'
                ? { cssBundle: logicalPath(detail.cssBundle, { ...options, key: true }) }
                : {}),
        };
    }
    return { ...metafile, inputs, outputs };
}

function writeFileAtomic(file, content) {
    const unique = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const temporary = `${file}.tmp-${unique}`;
    const backup = `${file}.backup-${unique}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, content, { flag: 'wx' });
    let backedUp = false;
    try {
        if (fs.existsSync(file)) {
            fs.renameSync(file, backup);
            backedUp = true;
        }
        try {
            fs.renameSync(temporary, file);
        } catch (error) {
            if (backedUp) {
                fs.renameSync(backup, file);
                backedUp = false;
            }
            throw error;
        }
        if (backedUp) {
            try {
                fs.rmSync(backup, { force: false });
            } catch {
                // The new metadata is already installed. A transient Windows
                // lock on the obsolete backup must not fail the build.
            }
        }
    } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
    }
}

function outputHashes(baseDirectory, metafile) {
    return Object.fromEntries(Object.keys(metafile.outputs).sort().map(output => {
        const outputPath = path.resolve(baseDirectory, output);
        assertWithin(baseDirectory, outputPath);
        const stat = fs.lstatSync(outputPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(`Esbuild output is not a regular file: ${output}`);
        }
        const hash = crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex');
        return [output, hash];
    }));
}

export function createProfileMetadataPlugin({ target, profileManifest, baseDirectory }) {
    const metadataFile = path.join(baseDirectory, 'lib', 'metadata', `${target}.json`);
    return {
        name: `ride-tauri-metadata-${target}`,
        setup(build) {
            build.onEnd(result => {
                if (result.errors.length > 0 || !result.metafile) {
                    fs.rmSync(metadataFile, { force: true });
                    return;
                }
                try {
                    const metafile = logicalizeMetafilePaths(result.metafile, { baseDirectory });
                    const record = {
                        schema: 'ride.esbuild-metafile@1',
                        profile: profileManifest.profile,
                        buildId: profileManifest.buildId,
                        digest: profileManifest.digest,
                        target,
                        outputHashes: outputHashes(baseDirectory, metafile),
                        metafile,
                    };
                    writeFileAtomic(metadataFile, `${JSON.stringify(record, null, 2)}\n`);
                } catch (error) {
                    fs.rmSync(metadataFile, { force: true });
                    throw error;
                }
            });
        },
    };
}
