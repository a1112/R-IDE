import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPORT_SCHEMA = 'ride.tauri-initial-bundle';
const REPORT_VERSION = 1;
const FRONTEND_OUTPUT_PREFIX = 'lib/frontend/';

function requireObject(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}

function requireSafeByteCount(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${label} must be a non-negative safe integer`);
    }
    return value;
}

function addByteCounts(left, right, label) {
    const total = left + right;
    if (!Number.isSafeInteger(total)) {
        throw new RangeError(`${label} exceeds the safe integer range`);
    }
    return total;
}

function normalizeLogicalPath(value, label, { allowAbsolute = false, allowParent = false } = {}) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
        throw new TypeError(`${label} must be a non-empty path`);
    }

    const slashPath = value.replaceAll('\\', '/');
    if (!allowAbsolute && (slashPath.startsWith('/') || /^[A-Za-z]:\//.test(slashPath))) {
        throw new TypeError(`${label} must be relative`);
    }

    const normalized = path.posix.normalize(slashPath).replace(/^\.\//, '');
    if (normalized === '.' || (!allowParent && (normalized === '..' || normalized.startsWith('../')))) {
        throw new TypeError(`${label} escapes the metadata root`);
    }
    return normalized;
}

function packageNameForInput(inputPath) {
    const marker = 'node_modules/';
    const markerIndex = inputPath.lastIndexOf(`/${marker}`);
    const packageStart = markerIndex >= 0
        ? markerIndex + marker.length + 1
        : inputPath.startsWith(marker)
            ? marker.length
            : -1;

    if (packageStart < 0) {
        if (inputPath === 'node_modules' || inputPath.endsWith('/node_modules')) {
            throw new TypeError(`Malformed package path: ${inputPath}`);
        }
        return undefined;
    }

    const packagePath = inputPath.slice(packageStart);
    const segments = packagePath.split('/');
    const first = segments[0];
    if (!first || first === '.' || first === '..') {
        throw new TypeError(`Malformed package path: ${inputPath}`);
    }
    if (first.startsWith('@')) {
        if (first.length === 1 || !segments[1] || segments[1] === '.' || segments[1] === '..') {
            throw new TypeError(`Malformed package path: ${inputPath}`);
        }
        return `${first}/${segments[1]}`;
    }
    return first;
}

function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

export function analyzeInitialBundle(metadata, entry = 'lib/frontend/bundle.js') {
    const metadataObject = requireObject(metadata, 'metadata');
    const metafile = Object.hasOwn(metadataObject, 'metafile')
        ? requireObject(metadataObject.metafile, 'metadata.metafile')
        : metadataObject;
    const outputs = requireObject(metafile.outputs, 'metadata outputs');
    const normalizedEntry = normalizeLogicalPath(entry, 'entry');
    const outputByPath = new Map();

    for (const [outputPath, output] of Object.entries(outputs)) {
        const normalizedOutputPath = normalizeLogicalPath(outputPath, 'output path');
        if (outputByPath.has(normalizedOutputPath)) {
            throw new TypeError(`Duplicate logical output: ${normalizedOutputPath}`);
        }
        outputByPath.set(normalizedOutputPath, requireObject(output, `output ${normalizedOutputPath}`));
    }

    if (!outputByPath.has(normalizedEntry)) {
        throw new TypeError(`Entry is missing from metadata outputs: ${normalizedEntry}`);
    }

    const visitState = new Map();
    const reachableOutputs = [];
    const logicalInputs = new Set();
    const packageBytes = new Map();
    let totalOutputBytes = 0;
    let totalInputBytes = 0;

    function visit(outputPath) {
        const state = visitState.get(outputPath);
        if (state === 'visiting') {
            throw new TypeError(`Import cycle detected at output: ${outputPath}`);
        }
        if (state === 'visited') {
            return;
        }
        if (!outputPath.startsWith(FRONTEND_OUTPUT_PREFIX)) {
            throw new TypeError(`Statically reachable output is outside lib/frontend: ${outputPath}`);
        }

        const output = outputByPath.get(outputPath);
        if (!output) {
            throw new TypeError(`Statically imported output is missing: ${outputPath}`);
        }

        visitState.set(outputPath, 'visiting');
        reachableOutputs.push(outputPath);
        totalOutputBytes = addByteCounts(
            totalOutputBytes,
            requireSafeByteCount(output.bytes, `output ${outputPath} bytes`),
            'total output bytes'
        );

        const inputs = requireObject(output.inputs, `output ${outputPath} inputs`);
        for (const [inputPath, input] of Object.entries(inputs)) {
            const normalizedInputPath = normalizeLogicalPath(inputPath, 'input path', {
                allowAbsolute: true,
                allowParent: true
            });
            if (logicalInputs.has(normalizedInputPath)) {
                throw new TypeError(`Duplicate logical input: ${normalizedInputPath}`);
            }
            logicalInputs.add(normalizedInputPath);

            const inputObject = requireObject(input, `input ${normalizedInputPath}`);
            const bytes = requireSafeByteCount(
                inputObject.bytesInOutput,
                `input ${normalizedInputPath} bytesInOutput`
            );
            totalInputBytes = addByteCounts(totalInputBytes, bytes, 'total input bytes');

            const packageName = packageNameForInput(normalizedInputPath);
            if (packageName !== undefined) {
                packageBytes.set(
                    packageName,
                    addByteCounts(packageBytes.get(packageName) ?? 0, bytes, `package ${packageName} bytes`)
                );
            }
        }

        if (!Array.isArray(output.imports)) {
            throw new TypeError(`output ${outputPath} imports must be an array`);
        }
        for (const importRecord of output.imports) {
            const importObject = requireObject(importRecord, `output ${outputPath} import`);
            if (importObject.kind === 'import-statement' && importObject.external !== true) {
                visit(normalizeLogicalPath(importObject.path, `output ${outputPath} import path`));
            }
        }

        visitState.set(outputPath, 'visited');
    }

    visit(normalizedEntry);

    const packages = Object.fromEntries([...packageBytes.entries()].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
    ));
    return deepFreeze({
        schema: REPORT_SCHEMA,
        version: REPORT_VERSION,
        entry: normalizedEntry,
        outputs: reachableOutputs.sort(),
        totalOutputBytes,
        totalInputBytes,
        packages
    });
}

async function runCli(argv) {
    if (argv.length !== 2 || argv[0] !== '--metadata' || !argv[1]) {
        throw new TypeError('Usage: node scripts/analyze-tauri-initial-bundle.mjs --metadata <path>');
    }

    const metadataPath = path.resolve(argv[1]);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    process.stdout.write(`${JSON.stringify(analyzeInitialBundle(metadata), null, 2)}\n`);
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (executedPath === import.meta.url) {
    runCli(process.argv.slice(2)).catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
