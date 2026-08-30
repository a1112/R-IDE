import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPORT_SCHEMA = 'ride.tauri-backend-initial-bundle';
const REPORT_VERSION = 1;
const MAIN_ENTRY = 'src-gen/backend/main.js';
const BROWSER_AUTOMATION_SOURCE = 'node_modules/@theia/ai-ide/lib/node/backend-module.js';
const BROWSER_AUTOMATION_TARGET = 'node_modules/@theia/ai-ide/lib/node/app-tester-agent/browser-automation-impl.js';
const BROWSER_AUTOMATION_RUNTIME_PACKAGES = Object.freeze([
    '@tootallnate/quickjs-emscripten',
    'chromium-bidi',
    'esprima',
    'puppeteer-core'
]);

function requireObject(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}

function requireArray(value, label) {
    if (!Array.isArray(value)) {
        throw new TypeError(`${label} must be an array`);
    }
    return value;
}

function requireNonEmptyString(value, label) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
        throw new TypeError(`${label} must be a non-empty string`);
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

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeLogicalPath(value, label, { allowAbsolute = false, allowParent = false } = {}) {
    requireNonEmptyString(value, label);
    const slashPath = value.replaceAll('\\', '/');
    const absolute = slashPath.startsWith('/') || /^[A-Za-z]:\//.test(slashPath);
    if (absolute && !allowAbsolute) {
        throw new TypeError(`${label} must be relative`);
    }

    const normalized = path.posix.normalize(slashPath).replace(/^\.\//, '');
    if (normalized === '.' || (!allowParent && (normalized === '..' || normalized.startsWith('../')))) {
        throw new TypeError(`${label} escapes the metadata root`);
    }
    return normalized;
}

function packageNameAt(segments, markerIndex, inputPath) {
    const first = segments[markerIndex + 1];
    if (!first || first === '.' || first === '..') {
        throw new TypeError(`Malformed package path: ${inputPath}`);
    }
    if (first.startsWith('@')) {
        const second = segments[markerIndex + 2];
        if (first.length === 1 || !second || second === '.' || second === '..') {
            throw new TypeError(`Malformed package path: ${inputPath}`);
        }
        return { name: `${first}/${second}`, endIndex: markerIndex + 2 };
    }
    return { name: first, endIndex: markerIndex + 1 };
}

function describePackageInput(inputPath) {
    const segments = inputPath.split('/');
    const packageSegments = [];
    for (let index = 0; index < segments.length; index += 1) {
        if (segments[index] === 'node_modules') {
            packageSegments.push({ markerIndex: index, ...packageNameAt(segments, index, inputPath) });
        }
    }
    if (packageSegments.length === 0) {
        if (inputPath === 'node_modules' || inputPath.endsWith('/node_modules')) {
            throw new TypeError(`Malformed package path: ${inputPath}`);
        }
        return undefined;
    }

    const names = packageSegments.map(candidate => candidate.name);
    if (new Set(names).size !== names.length) {
        throw new TypeError(`Cyclic package ancestry in input: ${inputPath}`);
    }

    const current = packageSegments.at(-1);
    const root = segments.slice(0, current.endIndex + 1).join('/');
    const relativePath = segments.slice(current.endIndex + 1).join('/');
    if (!relativePath) {
        throw new TypeError(`Malformed package path: ${inputPath}`);
    }
    return {
        root,
        name: current.name,
        ancestry: names.slice(0, -1),
        relativePath
    };
}

function normalizeInputMap(records, label, readRecord) {
    const object = requireObject(records, label);
    const normalized = new Map();
    for (const [recordPath, record] of Object.entries(object)) {
        const logicalPath = normalizeLogicalPath(recordPath, `${label} path`, {
            allowAbsolute: true,
            allowParent: true
        });
        if (normalized.has(logicalPath)) {
            throw new TypeError(`Duplicate logical input: ${logicalPath}`);
        }
        normalized.set(logicalPath, readRecord(record, logicalPath));
    }
    return normalized;
}

function prepareAnalysis(metadata) {
    const metadataObject = requireObject(metadata, 'metadata');
    const metafile = Object.hasOwn(metadataObject, 'metafile')
        ? requireObject(metadataObject.metafile, 'metadata.metafile')
        : metadataObject;
    const outputs = requireObject(metafile.outputs, 'metadata outputs');
    const outputByPath = new Map();
    const mainOutputs = [];

    for (const [outputPath, rawOutput] of Object.entries(outputs)) {
        const logicalOutputPath = normalizeLogicalPath(outputPath, 'output path');
        if (outputByPath.has(logicalOutputPath)) {
            throw new TypeError(`Duplicate logical output: ${logicalOutputPath}`);
        }
        const output = requireObject(rawOutput, `output ${logicalOutputPath}`);
        outputByPath.set(logicalOutputPath, output);
        if (typeof output.entryPoint === 'string') {
            const entryPoint = normalizeLogicalPath(output.entryPoint, `output ${logicalOutputPath} entryPoint`, {
                allowParent: true
            });
            if (entryPoint === MAIN_ENTRY) {
                mainOutputs.push({ path: logicalOutputPath, output });
            }
        }
    }

    if (mainOutputs.length === 0) {
        throw new TypeError(`Backend main output is missing for entry point ${MAIN_ENTRY}`);
    }
    if (mainOutputs.length > 1) {
        throw new TypeError(`Duplicate backend main output for entry point ${MAIN_ENTRY}`);
    }

    const { path: outputPath, output } = mainOutputs[0];
    const globalInputs = normalizeInputMap(metafile.inputs, 'metadata inputs', (record, inputPath) =>
        requireObject(record, `input ${inputPath}`)
    );
    let inputBytes = 0;
    const outputInputs = normalizeInputMap(output.inputs, `output ${outputPath} inputs`, (record, inputPath) => {
        const input = requireObject(record, `output input ${inputPath}`);
        const bytes = requireSafeByteCount(input.bytesInOutput, `input ${inputPath} bytesInOutput`);
        inputBytes = addByteCounts(inputBytes, bytes, 'backend main input bytes');
        return { bytes };
    });

    for (const inputPath of outputInputs.keys()) {
        if (!globalInputs.has(inputPath)) {
            throw new TypeError(`Missing metadata input record for bundled input: ${inputPath}`);
        }
    }
    if (!outputInputs.has(MAIN_ENTRY) || !globalInputs.has(MAIN_ENTRY)) {
        throw new TypeError(`Missing backend main input record: ${MAIN_ENTRY}`);
    }

    return {
        metafile,
        outputPath,
        output,
        outputBytes: requireSafeByteCount(output.bytes, `output ${outputPath} bytes`),
        inputBytes,
        outputInputs,
        globalInputs
    };
}

function normalizePackageManifests(packageManifests) {
    const manifests = new Map();
    for (const [index, rawManifest] of requireArray(packageManifests, 'packageManifests').entries()) {
        const manifest = requireObject(rawManifest, `package manifest record ${index}`);
        const root = normalizeLogicalPath(manifest.root, `package manifest record ${index} root`, {
            allowAbsolute: true,
            allowParent: true
        });
        if (manifests.has(root)) {
            throw new TypeError(`Duplicate package manifest root: ${root}`);
        }
        const descriptor = describePackageInput(`${root}/package.json`);
        if (!descriptor || descriptor.root !== root) {
            throw new TypeError(`Malformed package manifest root: ${root}`);
        }
        const name = requireNonEmptyString(manifest.name, `package manifest ${root} name`);
        const version = requireNonEmptyString(manifest.version, `package manifest ${root} version`);
        if (name !== descriptor.name) {
            throw new TypeError(`Package manifest name mismatch for ${descriptor.name}`);
        }
        manifests.set(root, { root, name, version });
    }
    return manifests;
}

function buildInputGraph(prepared) {
    const adjacency = new Map();
    for (const inputPath of prepared.outputInputs.keys()) {
        const input = prepared.globalInputs.get(inputPath);
        const edges = [];
        for (const [index, rawImport] of requireArray(input.imports, `input ${inputPath} imports`).entries()) {
            const importRecord = requireObject(rawImport, `input ${inputPath} import ${index}`);
            requireNonEmptyString(importRecord.kind, `input ${inputPath} import ${index} kind`);
            const importedPath = normalizeLogicalPath(
                importRecord.path,
                `input ${inputPath} import ${index} path`,
                { allowAbsolute: true, allowParent: true }
            );
            if (importRecord.external !== undefined && typeof importRecord.external !== 'boolean') {
                throw new TypeError(`input ${inputPath} import ${index} external must be boolean`);
            }
            if (importRecord.external === true) {
                if (prepared.outputInputs.has(importedPath)) {
                    throw new TypeError(`External import resolves to bundled input: ${importedPath}`);
                }
                continue;
            }
            if (!prepared.globalInputs.has(importedPath)) {
                throw new TypeError(`Missing metadata input record for import: ${importedPath}`);
            }
            if (prepared.outputInputs.has(importedPath)) {
                edges.push(importedPath);
            }
        }
        adjacency.set(inputPath, edges);
    }
    return adjacency;
}

function shortestPaths(adjacency) {
    const distance = new Map([[MAIN_ENTRY, 0]]);
    const predecessor = new Map();
    const queue = [MAIN_ENTRY];
    for (let index = 0; index < queue.length; index += 1) {
        const current = queue[index];
        for (const imported of adjacency.get(current) ?? []) {
            if (!distance.has(imported)) {
                distance.set(imported, distance.get(current) + 1);
                predecessor.set(imported, current);
                queue.push(imported);
            }
        }
    }
    return { distance, predecessor };
}

function reachableInputs(adjacency, skippedSource, skippedTarget) {
    const reachable = new Set();
    const queue = [MAIN_ENTRY];
    for (let index = 0; index < queue.length; index += 1) {
        const current = queue[index];
        if (reachable.has(current)) {
            continue;
        }
        reachable.add(current);
        for (const imported of adjacency.get(current) ?? []) {
            if (current === skippedSource && imported === skippedTarget) {
                continue;
            }
            if (!reachable.has(imported)) {
                queue.push(imported);
            }
        }
    }
    return reachable;
}

function reconstructPath(inputPath, predecessor) {
    const result = [];
    let current = inputPath;
    while (current !== undefined) {
        result.push(current);
        current = predecessor.get(current);
    }
    return result.reverse();
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

export function analyzeBackendInitialBundle(metadata, { packageManifests = [] } = {}) {
    const prepared = prepareAnalysis(metadata);
    const manifests = normalizePackageManifests(packageManifests);
    const inputPackages = new Map();
    const copiesByRoot = new Map();

    for (const [inputPath, { bytes }] of prepared.outputInputs) {
        const descriptor = describePackageInput(inputPath);
        if (!descriptor) {
            continue;
        }
        const manifest = manifests.get(descriptor.root);
        if (!manifest) {
            throw new TypeError(`Missing package manifest record for ${descriptor.name}`);
        }
        if (manifest.name !== descriptor.name) {
            throw new TypeError(`Package manifest name mismatch for ${descriptor.name}`);
        }
        let copy = copiesByRoot.get(descriptor.root);
        if (!copy) {
            copy = {
                root: descriptor.root,
                name: descriptor.name,
                version: manifest.version,
                ancestry: descriptor.ancestry,
                bytes: 0,
                inputs: []
            };
            copiesByRoot.set(descriptor.root, copy);
        }
        copy.bytes = addByteCounts(copy.bytes, bytes, `package copy ${copy.name} bytes`);
        copy.inputs.push(inputPath);
        inputPackages.set(inputPath, descriptor);
    }

    for (const root of manifests.keys()) {
        if (!copiesByRoot.has(root)) {
            throw new TypeError(`External package manifest record: ${manifests.get(root).name}`);
        }
    }

    const copiesByName = new Map();
    for (const copy of copiesByRoot.values()) {
        const group = copiesByName.get(copy.name) ?? [];
        group.push(copy);
        copiesByName.set(copy.name, group);
    }
    for (const [name, copies] of copiesByName) {
        copies.sort((left, right) =>
            compareText(left.ancestry.join('/'), right.ancestry.join('/'))
            || compareText(left.version, right.version)
            || compareText(left.root, right.root)
        );
        copies.forEach((copy, index) => {
            copy.id = `${name}@${copy.version}#${index + 1}`;
        });
    }

    const adjacency = buildInputGraph(prepared);
    const { distance, predecessor } = shortestPaths(adjacency);

    function displayInput(inputPath) {
        const descriptor = inputPackages.get(inputPath);
        if (descriptor) {
            const copy = copiesByRoot.get(descriptor.root);
            return `${copy.id}/${descriptor.relativePath}`;
        }
        if (inputPath.startsWith('/') || /^[A-Za-z]:\//.test(inputPath)) {
            return `workspace:${path.posix.basename(inputPath)}`;
        }
        return inputPath;
    }

    const packageCopies = [...copiesByRoot.values()]
        .sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id))
        .map(copy => {
            const reachable = copy.inputs
                .filter(inputPath => distance.has(inputPath))
                .sort((left, right) => distance.get(left) - distance.get(right) || compareText(left, right));
            const importerChain = reachable.length > 0
                ? reconstructPath(reachable[0], predecessor).map(displayInput)
                : null;
            return {
                id: copy.id,
                name: copy.name,
                version: copy.version,
                bytes: copy.bytes,
                ancestry: [...copy.ancestry],
                importerChain
            };
        });

    const packages = [...copiesByName.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([name, copies]) => ({
            name,
            bytes: copies.reduce((total, copy) => addByteCounts(total, copy.bytes, `package ${name} bytes`), 0),
            copyCount: copies.length,
            versions: [...new Set(copies.map(copy => copy.version))].sort(compareText)
        }));
    const packageByName = new Map(packages.map(packageRecord => [packageRecord.name, packageRecord]));
    const duplicates = packages
        .filter(packageRecord => packageRecord.copyCount > 1)
        .map(packageRecord => ({
            name: packageRecord.name,
            bytes: packageRecord.bytes,
            copies: packageCopies
                .filter(copy => copy.name === packageRecord.name)
                .map(copy => copy.id)
        }));
    const browserAutomationRuntimePackages = BROWSER_AUTOMATION_RUNTIME_PACKAGES
        .map(name => packageByName.get(name))
        .filter(Boolean)
        .map(packageRecord => ({
            name: packageRecord.name,
            bytes: packageRecord.bytes,
            copies: packageCopies.filter(copy => copy.name === packageRecord.name).map(copy => copy.id)
        }));
    const browserAutomationRuntimeBytes = browserAutomationRuntimePackages.reduce(
        (total, packageRecord) => addByteCounts(total, packageRecord.bytes, 'browser automation runtime bytes'),
        0
    );
    const browserAutomationPresent = adjacency.get(BROWSER_AUTOMATION_SOURCE)?.includes(BROWSER_AUTOMATION_TARGET) === true;
    const cutReachable = browserAutomationPresent
        ? reachableInputs(adjacency, BROWSER_AUTOMATION_SOURCE, BROWSER_AUTOMATION_TARGET)
        : new Set(distance.keys());
    const exclusiveInputs = browserAutomationPresent
        ? [...distance.keys()].filter(inputPath => !cutReachable.has(inputPath))
        : [];
    let browserAutomationExclusiveBytes = 0;
    const exclusiveBytesByName = new Map();
    const exclusiveBytesByCopy = new Map();
    for (const inputPath of exclusiveInputs) {
        const bytes = prepared.outputInputs.get(inputPath).bytes;
        browserAutomationExclusiveBytes = addByteCounts(
            browserAutomationExclusiveBytes,
            bytes,
            'browser automation exclusive bytes'
        );
        const descriptor = inputPackages.get(inputPath);
        if (!descriptor) {
            continue;
        }
        const copy = copiesByRoot.get(descriptor.root);
        exclusiveBytesByName.set(
            copy.name,
            addByteCounts(exclusiveBytesByName.get(copy.name) ?? 0, bytes, `exclusive package ${copy.name} bytes`)
        );
        exclusiveBytesByCopy.set(
            copy.id,
            addByteCounts(exclusiveBytesByCopy.get(copy.id) ?? 0, bytes, `exclusive package copy ${copy.id} bytes`)
        );
    }
    const browserAutomationExclusivePackages = [...exclusiveBytesByName.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([name, bytes]) => ({
            name,
            bytes,
            copies: packageCopies
                .filter(copy => copy.name === name && exclusiveBytesByCopy.has(copy.id))
                .map(copy => ({ id: copy.id, bytes: exclusiveBytesByCopy.get(copy.id) }))
        }));
    const browserAutomationExclusiveRuntimeBytes = BROWSER_AUTOMATION_RUNTIME_PACKAGES.reduce(
        (total, name) => addByteCounts(
            total,
            exclusiveBytesByName.get(name) ?? 0,
            'browser automation exclusive runtime bytes'
        ),
        0
    );
    const browserAutomationSharedRuntimePackages = browserAutomationRuntimePackages
        .map(packageRecord => ({
            name: packageRecord.name,
            bytes: packageRecord.bytes - (exclusiveBytesByName.get(packageRecord.name) ?? 0),
            copies: packageRecord.copies
        }))
        .filter(packageRecord => packageRecord.bytes > 0);
    const browserAutomationSharedRuntimeBytes = browserAutomationRuntimeBytes
        - browserAutomationExclusiveRuntimeBytes;

    return deepFreeze({
        schema: REPORT_SCHEMA,
        version: REPORT_VERSION,
        output: {
            path: prepared.outputPath,
            entryPoint: MAIN_ENTRY,
            bytes: prepared.outputBytes,
            inputBytes: prepared.inputBytes,
            inputCount: prepared.outputInputs.size
        },
        packages,
        packageCopies,
        duplicates,
        evidence: {
            browserAutomation: {
                source: BROWSER_AUTOMATION_SOURCE,
                target: BROWSER_AUTOMATION_TARGET,
                present: browserAutomationPresent,
                reachableRuntimeBytes: browserAutomationRuntimeBytes,
                reachableRuntimePackages: browserAutomationRuntimePackages,
                exclusiveBytes: browserAutomationExclusiveBytes,
                exclusiveInputCount: exclusiveInputs.length,
                exclusiveRuntimeBytes: browserAutomationExclusiveRuntimeBytes,
                exclusivePackages: browserAutomationExclusivePackages,
                sharedRuntimeBytes: browserAutomationSharedRuntimeBytes,
                sharedRuntimePackages: browserAutomationSharedRuntimePackages
            }
        }
    });
}

function packagePathSegments(name) {
    return name.startsWith('@') ? name.split('/') : [name];
}

function packageChainSegments(descriptor) {
    const result = [];
    for (const name of [...descriptor.ancestry, descriptor.name]) {
        result.push('node_modules', ...packagePathSegments(name));
    }
    return result;
}

async function readManifestCandidate(candidate) {
    try {
        return JSON.parse(await readFile(path.join(candidate, 'package.json'), 'utf8'));
    } catch (error) {
        if (error && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
            return undefined;
        }
        throw error;
    }
}

async function findInstalledPackageDirectory(name, fromDirectory) {
    const packageSegments = packagePathSegments(name);
    let current = path.resolve(fromDirectory);
    for (;;) {
        const candidate = path.join(current, 'node_modules', ...packageSegments);
        if (await readManifestCandidate(candidate) !== undefined) {
            return candidate;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    return undefined;
}

async function resolveLogicalPackageChain(descriptor, fallbackDirectory) {
    let context = fallbackDirectory;
    for (const name of descriptor.ancestry) {
        const packageDirectory = await findInstalledPackageDirectory(name, context);
        if (!packageDirectory) {
            return undefined;
        }
        context = packageDirectory;
    }
    return findInstalledPackageDirectory(descriptor.name, context);
}

async function loadPackageManifest(descriptor, logicalBuildDirectory, fallbackDirectory) {
    const candidates = [path.resolve(logicalBuildDirectory, descriptor.root)];
    const resolvedChain = await resolveLogicalPackageChain(descriptor, fallbackDirectory);
    if (resolvedChain) {
        candidates.push(resolvedChain);
    }

    const chain = packageChainSegments(descriptor);
    let current = path.resolve(fallbackDirectory);
    for (;;) {
        candidates.push(path.join(current, ...chain));
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }

    const visited = new Set();
    for (const candidate of candidates) {
        const normalized = path.resolve(candidate);
        if (visited.has(normalized)) {
            continue;
        }
        visited.add(normalized);
        const manifest = await readManifestCandidate(normalized);
        if (manifest !== undefined) {
            const object = requireObject(manifest, `package manifest for ${descriptor.name}`);
            return {
                root: descriptor.root,
                name: requireNonEmptyString(object.name, `package manifest ${descriptor.name} name`),
                version: requireNonEmptyString(object.version, `package manifest ${descriptor.name} version`)
            };
        }
    }
    throw new TypeError(`Missing package manifest for ${descriptor.name}`);
}

async function loadPackageManifests(metadata, logicalBuildDirectory, fallbackDirectory) {
    const prepared = prepareAnalysis(metadata);
    const descriptors = new Map();
    for (const inputPath of prepared.outputInputs.keys()) {
        const descriptor = describePackageInput(inputPath);
        if (descriptor && !descriptors.has(descriptor.root)) {
            descriptors.set(descriptor.root, descriptor);
        }
    }
    return Promise.all(
        [...descriptors.values()]
            .sort((left, right) => compareText(left.root, right.root))
            .map(descriptor => loadPackageManifest(descriptor, logicalBuildDirectory, fallbackDirectory))
    );
}

async function runCli(argv) {
    if (argv.length !== 2 || argv[0] !== '--metadata' || !argv[1]) {
        throw new TypeError('Usage: node scripts/analyze-tauri-backend-initial-bundle.mjs --metadata <path>');
    }
    const metadataPath = path.resolve(argv[1]);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const metadataObject = requireObject(metadata, 'metadata');
    const buildId = requireNonEmptyString(metadataObject.buildId, 'metadata buildId');
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(buildId)) {
        throw new TypeError('metadata buildId must be canonical');
    }
    const browserDirectory = path.resolve(path.dirname(metadataPath), '..', '..');
    const logicalBuildDirectory = path.join(
        browserDirectory,
        '.ride-tauri-profile',
        'builds',
        buildId
    );
    const packageManifests = await loadPackageManifests(
        metadata,
        logicalBuildDirectory,
        browserDirectory
    );
    process.stdout.write(`${JSON.stringify(analyzeBackendInitialBundle(metadata, { packageManifests }), null, 2)}\n`);
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (executedPath === import.meta.url) {
    runCli(process.argv.slice(2)).catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
