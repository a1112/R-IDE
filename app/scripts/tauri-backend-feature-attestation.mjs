// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ESBUILD_METADATA_SCHEMA = 'ride.esbuild-metafile@1';

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function normalize(candidate) {
    return candidate.replaceAll('\\', '/').replace(/^\.\//, '');
}

function portableRelativePathIdentity(candidate) {
    return normalize(candidate).toLowerCase();
}

function canonicalPath(candidate, prefix) {
    return typeof candidate === 'string'
        && candidate.startsWith(prefix)
        && !candidate.includes('\\')
        && candidate.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}

function canonicalPackageName(candidate) {
    return typeof candidate === 'string'
        && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(candidate);
}

function moduleInput(input, request) {
    const candidate = normalize(input);
    return candidate === `node_modules/${request}` || candidate === `node_modules/${request}.js`;
}

function packageInput(input, packageName) {
    return `/${normalize(input)}/`.includes(`/node_modules/${packageName}/`);
}

function exactFields(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    return Object.keys(value).sort(compareText).join('\0') === [...expected].sort(compareText).join('\0');
}

export function deferredBackendDescriptors(manifest) {
    const records = Object.entries(manifest?.featureGroups ?? {})
        .sort(([left], [right]) => compareText(left, right))
        .flatMap(([groupName, group]) => (group?.deferredBackendModules ?? []).map(descriptor => ({
            groupName,
            descriptor,
        })))
        .sort((left, right) => compareText(String(left.descriptor?.action), String(right.descriptor?.action)));
    if (manifest?.profile === 'full') {
        if (records.length > 0) {
            throw new Error('Full profile must not install deferred backend descriptors.');
        }
        return [];
    }
    if (records.length > 0 && manifest?.profile !== 'tauri-critical') {
        throw new Error('Deferred backend descriptors require the tauri-critical profile.');
    }

    const inventories = new Map([
        ['edge', new Set()],
        ['package', new Set()],
        ['module', new Set()],
        ['proxy', new Set()],
        ['entry', new Set()],
        ['output', new Set()],
        ['action', new Set()],
    ]);
    const expectedFields = [
        'action',
        'entry',
        'exclusiveInputCount',
        'importer',
        'module',
        'output',
        'package',
        'proxy',
        'runtimePackages',
    ];
    for (const { groupName, descriptor } of records) {
        const canonicalModule = candidate => (
            typeof descriptor?.package === 'string'
            && canonicalPath(candidate, `${descriptor.package}/`)
        );
        if (!exactFields(descriptor, expectedFields)
            || !canonicalPackageName(descriptor.package)
            || !canonicalModule(descriptor.importer)
            || !canonicalModule(descriptor.module)
            || !canonicalPath(descriptor.proxy, 'tauri-src/backend/')
            || !canonicalPath(descriptor.entry, 'tauri-src/backend/')
            || !canonicalPath(descriptor.output, 'lib/backend/')
            || !descriptor.output.endsWith('.cjs')
            || typeof descriptor.action !== 'string'
            || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(descriptor.action)
            || !Array.isArray(descriptor.runtimePackages)
            || descriptor.runtimePackages.length === 0
            || descriptor.runtimePackages.some(packageName => !canonicalPackageName(packageName))
            || new Set(descriptor.runtimePackages).size !== descriptor.runtimePackages.length
            || [...descriptor.runtimePackages].sort(compareText).join('\0') !== descriptor.runtimePackages.join('\0')
            || !Number.isSafeInteger(descriptor.exclusiveInputCount)
            || descriptor.exclusiveInputCount <= 0) {
            throw new Error(`Deferred backend descriptor is invalid for ${groupName}.`);
        }
        for (const [kind, identity] of [
            ['edge', `${descriptor.importer}\0${descriptor.module}`],
            ['package', descriptor.package],
            ['module', descriptor.module],
            ['proxy', portableRelativePathIdentity(descriptor.proxy)],
            ['entry', portableRelativePathIdentity(descriptor.entry)],
            ['output', descriptor.output],
            ['action', descriptor.action],
        ]) {
            const inventory = inventories.get(kind);
            if (inventory.has(identity)) {
                throw new Error(`Deferred backend ${kind} is duplicated: ${identity.replace('\0', ' -> ')}.`);
            }
            inventory.add(identity);
        }
    }
    return records;
}

function insideDirectory(baseDirectory, candidate) {
    const relative = path.relative(path.resolve(baseDirectory), path.resolve(candidate));
    return Boolean(relative)
        && relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

function nativeRealpath(candidate) {
    return fs.realpathSync.native?.(candidate) ?? fs.realpathSync(candidate);
}

function physicalFileIdentities(candidate) {
    const realpath = nativeRealpath(candidate);
    const stat = fs.statSync(candidate, { bigint: true });
    const identities = [`realpath:${process.platform === 'win32' ? realpath.toLowerCase() : realpath}`];
    if (stat.dev !== 0n || stat.ino !== 0n) {
        identities.push(`file:${stat.dev}:${stat.ino}`);
    }
    return identities;
}

export function assertDeferredBackendSourceIdentities(descriptorRecords, browserDirectory) {
    const resolvedBrowserDirectory = path.resolve(browserDirectory);
    const logicalInventories = new Map([
        ['proxy', new Set()],
        ['entry', new Set()],
    ]);
    const physicalInventories = new Map([
        ['proxy', new Map()],
        ['entry', new Map()],
    ]);
    for (const { groupName, descriptor } of descriptorRecords) {
        for (const field of ['proxy', 'entry']) {
            const source = descriptor?.[field];
            const label = `Deferred backend ${field} for ${groupName}/${descriptor?.action ?? '<unknown>'}`;
            const logicalIdentity = portableRelativePathIdentity(source ?? '');
            if (logicalInventories.get(field).has(logicalIdentity)) {
                throw new Error(`Deferred backend ${field} is duplicated: ${source}.`);
            }
            logicalInventories.get(field).add(logicalIdentity);
            const candidate = path.resolve(resolvedBrowserDirectory, source ?? '');
            if (!insideDirectory(resolvedBrowserDirectory, candidate)) {
                throw new Error(`${label} must stay inside the browser application: ${source}.`);
            }
            let stat;
            try {
                stat = fs.lstatSync(candidate);
            } catch (error) {
                throw new Error(`${label} is missing: ${source} (${error.message}).`);
            }
            if (stat.isSymbolicLink() || !stat.isFile()) {
                throw new Error(`${label} must be a regular file: ${source}.`);
            }
            for (const identity of physicalFileIdentities(candidate)) {
                const existing = physicalInventories.get(field).get(identity);
                if (existing) {
                    throw new Error(
                        `Deferred backend ${field} physical identity is duplicated: ${existing} and ${source}.`,
                    );
                }
                physicalInventories.get(field).set(identity, source);
            }
        }
    }
}

function absoluteMetadataPath(candidate) {
    if (typeof candidate !== 'string') {
        return false;
    }
    const namespace = candidate.match(/^(?:node-file|file):/i)?.[0] ?? '';
    const raw = (namespace ? candidate.slice(namespace.length) : candidate).replaceAll('\\', '/');
    return /^[A-Za-z]:\//.test(raw)
        || /^\/[A-Za-z]:\//.test(raw)
        || raw.startsWith('//')
        || raw.startsWith('/');
}

function assertPortablePath(candidate, label) {
    if (absoluteMetadataPath(candidate)) {
        throw new Error(`${label} contains an absolute metadata path: ${candidate}.`);
    }
}

export function assertPortableMetafilePaths(metafile, label = 'Esbuild metadata') {
    if (!metafile || typeof metafile !== 'object'
        || !metafile.inputs || typeof metafile.inputs !== 'object' || Array.isArray(metafile.inputs)
        || !metafile.outputs || typeof metafile.outputs !== 'object' || Array.isArray(metafile.outputs)) {
        throw new Error(`${label} does not contain an esbuild metafile.`);
    }
    const inspectImports = (imports, owner) => {
        if (imports === undefined) {
            return;
        }
        if (!Array.isArray(imports)) {
            throw new Error(`${owner} imports must be an array.`);
        }
        for (const imported of imports) {
            if (typeof imported?.path === 'string') {
                assertPortablePath(imported.path, `${owner} import path`);
            }
            if (typeof imported?.original === 'string') {
                assertPortablePath(imported.original, `${owner} import original`);
            }
        }
    };
    for (const [input, detail] of Object.entries(metafile.inputs)) {
        assertPortablePath(input, `${label} input`);
        inspectImports(detail?.imports, `${label} input ${input}`);
    }
    for (const [output, detail] of Object.entries(metafile.outputs)) {
        assertPortablePath(output, `${label} output`);
        if (typeof detail?.entryPoint === 'string') {
            assertPortablePath(detail.entryPoint, `${label} output entry point`);
        }
        if (typeof detail?.cssBundle === 'string') {
            assertPortablePath(detail.cssBundle, `${label} CSS bundle`);
        }
        for (const input of Object.keys(detail?.inputs ?? {})) {
            assertPortablePath(input, `${label} output input`);
        }
        inspectImports(detail?.imports, `${label} output ${output}`);
    }
}

export function assertPortableMetadataRecord(record, label = 'Esbuild metadata') {
    assertPortableMetafilePaths(record?.metafile, label);
    if (!record.outputHashes || typeof record.outputHashes !== 'object' || Array.isArray(record.outputHashes)) {
        throw new Error(`${label} does not contain output hashes.`);
    }
    for (const output of Object.keys(record.outputHashes)) {
        assertPortablePath(output, `${label} output hash`);
    }
}

function readJson(file, label) {
    let stat;
    try {
        stat = fs.lstatSync(file);
    } catch (error) {
        throw new Error(`${label} is missing: ${file} (${error.message}).`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`${label} must be a regular file: ${file}.`);
    }
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`${label} is malformed: ${file} (${error.message}).`);
    }
}

function readMetadata(libDirectory, target, manifest) {
    const label = `Tauri ${target} metadata`;
    const record = readJson(path.join(libDirectory, 'metadata', `${target}.json`), label);
    if (!exactFields(record, ['schema', 'profile', 'buildId', 'digest', 'target', 'outputHashes', 'metafile'])
        || record.schema !== ESBUILD_METADATA_SCHEMA
        || record.profile !== manifest.profile
        || record.buildId !== manifest.buildId
        || record.digest !== manifest.digest
        || record.target !== target) {
        throw new Error(`${label} identity mismatch.`);
    }
    assertPortableMetadataRecord(record, label);
    return record;
}

function assertInside(root, candidate, label) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`${label} escapes the published lib directory.`);
    }
}

function outputFile(libDirectory, logicalOutput, label) {
    const normalized = normalize(logicalOutput);
    if (!normalized.startsWith('lib/')) {
        throw new Error(`${label} is not a logical lib output: ${logicalOutput}.`);
    }
    const candidate = path.resolve(libDirectory, ...normalized.slice('lib/'.length).split('/'));
    assertInside(libDirectory, candidate, label);
    let stat;
    try {
        stat = fs.lstatSync(candidate);
    } catch (error) {
        throw new Error(`${label} is missing: ${logicalOutput} (${error.message}).`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`${label} must be a regular file: ${logicalOutput}.`);
    }
    return candidate;
}

function verifyOutput(record, output, entry, libDirectory, label, { onlyOutput = false } = {}) {
    const outputKeys = Object.keys(record.metafile.outputs);
    const hashKeys = Object.keys(record.outputHashes);
    if ((onlyOutput && outputKeys.length !== 1)
        || !Object.hasOwn(record.metafile.outputs, output)) {
        throw new Error(`${label} has the wrong output inventory; expected ${output}.`);
    }
    if ((onlyOutput && hashKeys.length !== 1) || !Object.hasOwn(record.outputHashes, output)) {
        throw new Error(`${label} has the wrong output hash inventory; expected ${output}.`);
    }
    const detail = record.metafile.outputs[output];
    if (normalize(detail?.entryPoint ?? '') !== entry) {
        throw new Error(`${label} has the wrong entry point; expected ${entry}, found ${detail?.entryPoint ?? '<missing>'}.`);
    }
    if (!detail.inputs || typeof detail.inputs !== 'object' || Array.isArray(detail.inputs)) {
        throw new Error(`${label} has no input inventory.`);
    }
    const missingGraphInputs = Object.keys(detail.inputs).filter(input => !Object.hasOwn(record.metafile.inputs, input));
    if (missingGraphInputs.length > 0) {
        throw new Error(`${label} input graph is inconsistent: ${missingGraphInputs[0]}.`);
    }
    const file = outputFile(libDirectory, output, label);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (record.outputHashes[output] !== actual) {
        throw new Error(`${label} output hash mismatch: expected ${record.outputHashes[output] ?? '<missing>'}, found ${actual}.`);
    }
    return detail;
}

function relativeModuleRequest(descriptor) {
    const relative = path.posix.relative(path.posix.dirname(descriptor.importer), descriptor.module);
    return relative.startsWith('.') ? relative : `./${relative}`;
}

export function attestDeferredBackendFeatures({ manifest, libDirectory } = {}) {
    const descriptors = deferredBackendDescriptors(manifest);
    if (descriptors.length === 0) {
        return [];
    }
    const resolvedLib = path.resolve(libDirectory);
    const backendRecord = readMetadata(resolvedLib, 'backend', manifest);
    const mainDetail = verifyOutput(
        backendRecord,
        'lib/backend/main.js',
        'src-gen/backend/main.js',
        resolvedLib,
        'Backend main',
    );
    const mainInputs = Object.keys(mainDetail.inputs);
    const report = [];

    for (const { groupName, descriptor } of descriptors) {
        const label = `Deferred backend feature ${groupName}/${descriptor.action}`;
        const importerInputs = mainInputs.filter(input => moduleInput(input, descriptor.importer));
        if (importerInputs.length !== 1) {
            throw new Error(`${label} requires exactly one importer input for ${descriptor.importer}.`);
        }
        const importer = importerInputs[0];
        const imports = backendRecord.metafile.inputs[importer]?.imports;
        if (!Array.isArray(imports)) {
            throw new Error(`${label} importer has no import records.`);
        }
        const expectedRequest = relativeModuleRequest(descriptor);
        const requestRecords = imports.filter(imported => imported?.original === expectedRequest);
        const proxyRecords = imports.filter(imported => normalize(imported?.path ?? '') === descriptor.proxy);
        if (requestRecords.length !== 1 || proxyRecords.length !== 1 || requestRecords[0] !== proxyRecords[0]) {
            throw new Error(`${label} exact alias edge must have exactly one import record with original ${expectedRequest} resolved to ${descriptor.proxy}.`);
        }
        const aliasRecord = requestRecords[0];
        if (aliasRecord.external === true) {
            throw new Error(`${label} exact alias edge must not be external.`);
        }
        if (aliasRecord.kind !== 'require-call') {
            throw new Error(`${label} exact alias edge has unsupported static import kind ${aliasRecord.kind ?? '<missing>'}.`);
        }
        if (!mainInputs.includes(descriptor.proxy) || !Object.hasOwn(backendRecord.metafile.inputs, descriptor.proxy)) {
            throw new Error(`${label} proxy is missing from backend main.`);
        }
        if (mainInputs.some(input => moduleInput(input, descriptor.module))
            || Object.keys(backendRecord.metafile.inputs).some(input => moduleInput(input, descriptor.module))) {
            throw new Error(`${label} real implementation is present in backend main.`);
        }
        if ((mainDetail.imports ?? []).some(imported => normalize(imported?.path ?? '') === descriptor.output)) {
            throw new Error(`${label} is statically imported by backend main.`);
        }

        const target = `backend-${descriptor.action}`;
        const featureRecord = readMetadata(resolvedLib, target, manifest);
        const featureDetail = verifyOutput(
            featureRecord,
            descriptor.output,
            descriptor.entry,
            resolvedLib,
            label,
            { onlyOutput: true },
        );
        const featureInputs = Object.keys(featureDetail.inputs);
        if (!featureInputs.includes(descriptor.entry)) {
            throw new Error(`${label} is missing its logical entry input ${descriptor.entry}.`);
        }
        if (!featureInputs.some(input => moduleInput(input, descriptor.module))) {
            throw new Error(`${label} is missing its real implementation ${descriptor.module}.`);
        }
        for (const runtimePackage of descriptor.runtimePackages) {
            if (!featureInputs.some(input => packageInput(input, runtimePackage))) {
                throw new Error(`${label} runtime package ${runtimePackage} is missing.`);
            }
        }
        const mainSet = new Set(mainInputs);
        const exclusiveInputs = featureInputs.filter(input => input !== descriptor.entry && !mainSet.has(input));
        if (exclusiveInputs.length !== descriptor.exclusiveInputCount) {
            throw new Error(`${label} exclusive input count is ${exclusiveInputs.length}, expected ${descriptor.exclusiveInputCount}; the service graph may overlap backend main.`);
        }
        report.push({ action: descriptor.action, output: descriptor.output });
    }
    return report;
}
