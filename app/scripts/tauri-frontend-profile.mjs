import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const semver = require('semver');

export const PROFILE_SCHEMA = 'ride.tauri-frontend-profile@2';
export const PROFILE_DIRECTORY_NAME = '.ride-tauri-profile';
const PROFILE_MANIFEST_NAME = 'ride-tauri-profile.json';
const CUSTOM_FILES = ['esbuild.mjs', 'ride-esbuild-dedupe.mjs'];
const CUSTOM_DIRECTORIES = ['resources', 'ico'];
const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function currentCommit() {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repositoryDirectory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        maxBuffer: 1024,
    }).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) {
        throw new Error('Current Git commit is not canonical.');
    }
    return commit;
}

async function defaultSourceIdentity() {
    const commit = currentCommit();
    const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no', '--', 'app'], {
        cwd: repositoryDirectory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
        maxBuffer: 1024 * 1024,
    }).trim();
    return { commit, clean: status === '' };
}

function validateSourceIdentity(identity) {
    const keys = identity && typeof identity === 'object' && !Array.isArray(identity)
        ? Object.keys(identity).sort(compareText)
        : [];
    if (keys.join('\0') !== ['clean', 'commit'].join('\0')
        || !/^[0-9a-f]{40}$/.test(identity.commit ?? '')
        || identity.clean !== true) {
        throw new Error('The tracked source tree must be clean with a canonical current commit.');
    }
    return { commit: identity.commit, clean: true };
}

function canonicalJson(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new TypeError('Canonical JSON does not support non-finite numbers.');
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const entries = Object.keys(value)
            .sort(compareText)
            .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
        return `{${entries.join(',')}}`;
    }
    throw new TypeError(`Unsupported canonical JSON value: ${typeof value}.`);
}

export function canonicalDigest(value) {
    return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function parseDependencySpec(requestName, spec) {
    if (typeof spec !== 'string' || spec.trim() === '') {
        throw new Error(`Dependency "${requestName}" has an invalid version specifier.`);
    }
    if (!spec.startsWith('npm:')) {
        return { packageName: requestName, range: spec };
    }

    const alias = spec.slice(4);
    const separator = alias.lastIndexOf('@');
    if (separator <= 0 || separator === alias.length - 1) {
        throw new Error(`Dependency "${requestName}" has an invalid npm alias "${spec}".`);
    }
    return {
        packageName: alias.slice(0, separator),
        range: alias.slice(separator + 1),
    };
}

function validateInstalledManifest(
    requestName,
    spec,
    manifest,
    dependencyPath,
    constraint = 'dependency',
    enforceRange = true,
) {
    if (!manifest || typeof manifest !== 'object') {
        throw new Error(`${dependencyPath.join(' -> ')}: required dependency is not installed.`);
    }
    const expected = parseDependencySpec(requestName, spec);
    if (manifest.name !== expected.packageName) {
        throw new Error(`${dependencyPath.join(' -> ')}: expected package name "${expected.packageName}", found "${manifest.name ?? '<missing>'}".`);
    }
    if (typeof manifest.version !== 'string' || !semver.valid(manifest.version)) {
        throw new Error(`${dependencyPath.join(' -> ')}: installed package has invalid version "${manifest.version ?? '<missing>'}".`);
    }
    const validRange = semver.validRange(expected.range);
    if (!validRange) {
        throw new Error(`${dependencyPath.join(' -> ')}: dependency "${requestName}" has invalid ${constraint} range "${expected.range}".`);
    }
    if (enforceRange && !semver.satisfies(manifest.version, validRange)) {
        throw new Error(`${dependencyPath.join(' -> ')}: installed version ${manifest.version} does not satisfy ${constraint} range ${expected.range}.`);
    }
    return expected;
}

function normalizedFeatureGroups(featureGroups, browserDependencies) {
    if (!featureGroups || typeof featureGroups !== 'object' || Array.isArray(featureGroups)) {
        throw new Error('Profile configuration must declare a featureGroups inventory.');
    }
    const result = {};
    const classifiedRoots = new Map();
    for (const groupName of Object.keys(featureGroups).sort(compareText)) {
        const value = featureGroups[groupName];
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(`Feature group "${groupName}" must be an object.`);
        }
        const unexpectedFields = Object.keys(value).filter(key => key !== 'deferredRoots' && key !== 'blockedRoots');
        if (unexpectedFields.length > 0) {
            throw new Error(`Feature group "${groupName}" has unsupported field "${unexpectedFields.sort(compareText)[0]}".`);
        }
        const deferredRoots = value.deferredRoots;
        const blockedRoots = value.blockedRoots;
        if (!Array.isArray(deferredRoots) || deferredRoots.some(root => typeof root !== 'string' || !root)) {
            throw new Error(`Feature group "${groupName}" must contain exact deferredRoots package names.`);
        }
        if (!Array.isArray(blockedRoots)) {
            throw new Error(`Feature group "${groupName}" must contain blockedRoots evidence entries.`);
        }
        const duplicateDeferred = deferredRoots.find((name, index) => deferredRoots.indexOf(name) !== index);
        if (duplicateDeferred) {
            throw new Error(`Feature root "${duplicateDeferred}" is duplicated in group "${groupName}".`);
        }
        const normalizedBlocked = blockedRoots.map(entry => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)
                || typeof entry.name !== 'string' || !entry.name) {
                throw new Error(`Feature group "${groupName}" has an invalid blocked root entry.`);
            }
            const unexpected = Object.keys(entry).filter(key => key !== 'name' && key !== 'reason');
            if (unexpected.length > 0) {
                throw new Error(`Blocked root "${entry.name}" has unsupported field "${unexpected.sort(compareText)[0]}".`);
            }
            if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
                throw new Error(`Blocked root "${entry.name}" must have an explicit reason.`);
            }
            if (entry.reason !== entry.reason.trim()) {
                throw new Error(`Blocked root "${entry.name}" reason must be canonical.`);
            }
            return { name: entry.name, reason: entry.reason };
        });
        const duplicateBlocked = normalizedBlocked.find((entry, index) => (
            normalizedBlocked.findIndex(candidate => candidate.name === entry.name) !== index
        ));
        if (duplicateBlocked) {
            throw new Error(`Feature root "${duplicateBlocked.name}" is duplicated in group "${groupName}".`);
        }
        const localBlocked = new Set(normalizedBlocked.map(entry => entry.name));
        const ambiguous = deferredRoots.find(name => localBlocked.has(name));
        if (ambiguous) {
            throw new Error(`Feature root "${ambiguous}" cannot be both deferred and blocked.`);
        }
        for (const [name, classification] of [
            ...deferredRoots.map(name => [name, 'deferred']),
            ...normalizedBlocked.map(entry => [entry.name, 'blocked']),
        ]) {
            if (!Object.hasOwn(browserDependencies, name)) {
                throw new Error(`Unknown feature root "${name}" in group "${groupName}".`);
            }
            if (classifiedRoots.has(name)) {
                throw new Error(`Feature root "${name}" is declared in more than one feature group.`);
            }
            classifiedRoots.set(name, { groupName, classification });
        }
        result[groupName] = {
            deferredRoots: [...deferredRoots].sort(compareText),
            blockedRoots: normalizedBlocked.sort((left, right) => compareText(left.name, right.name)),
        };
    }
    return result;
}

function stableStronglyConnectedOrder(nodes, dependenciesByNode) {
    let nextIndex = 0;
    const indexes = new Map();
    const lowLinks = new Map();
    const stack = [];
    const onStack = new Set();
    const components = [];

    const visit = node => {
        indexes.set(node, nextIndex);
        lowLinks.set(node, nextIndex);
        nextIndex += 1;
        stack.push(node);
        onStack.add(node);

        for (const dependency of [...(dependenciesByNode.get(node) ?? [])].sort(compareText)) {
            if (!indexes.has(dependency)) {
                visit(dependency);
                lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(dependency)));
            } else if (onStack.has(dependency)) {
                lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(dependency)));
            }
        }

        if (lowLinks.get(node) === indexes.get(node)) {
            const component = [];
            let member;
            do {
                member = stack.pop();
                onStack.delete(member);
                component.push(member);
            } while (member !== node);
            components.push(component.sort(compareText));
        }
    };

    for (const node of [...nodes].sort(compareText)) {
        if (!indexes.has(node)) {
            visit(node);
        }
    }

    const componentByNode = new Map();
    components.forEach((component, index) => component.forEach(node => componentByNode.set(node, index)));
    const componentDependencies = components.map(() => new Set());
    for (const node of nodes) {
        const component = componentByNode.get(node);
        for (const dependency of dependenciesByNode.get(node) ?? []) {
            const dependencyComponent = componentByNode.get(dependency);
            if (component !== dependencyComponent) {
                componentDependencies[component].add(dependencyComponent);
            }
        }
    }

    const visitedComponents = new Set();
    const ordered = [];
    const visitComponent = component => {
        if (visitedComponents.has(component)) {
            return;
        }
        visitedComponents.add(component);
        const dependencies = [...componentDependencies[component]].sort((left, right) => {
            return compareText(components[left][0], components[right][0]);
        });
        dependencies.forEach(visitComponent);
        ordered.push(...components[component]);
    };
    [...components.keys()]
        .sort((left, right) => compareText(components[left][0], components[right][0]))
        .forEach(visitComponent);
    return ordered;
}

function dependencyEntries(manifest) {
    const entries = new Map();
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
        entries.set(name, { spec, optional: false });
    }
    for (const [name, spec] of Object.entries(manifest.peerDependencies ?? {})) {
        if (manifest.peerDependenciesMeta?.[name]?.optional === true) {
            continue;
        }
        if (!entries.has(name)) {
            entries.set(name, {
                spec,
                optional: false,
            });
        }
    }
    return [...entries.entries()].sort(([left], [right]) => compareText(left, right));
}

function isTheiaExtension(manifest) {
    return Array.isArray(manifest?.theiaExtensions) && manifest.theiaExtensions.length > 0;
}

export function resolveProfile({
    profileName = 'tauri-critical',
    profileConfig,
    browserManifest,
    packageManifests,
    installedGraph,
}) {
    if (!profileConfig || profileConfig.schema !== PROFILE_SCHEMA) {
        throw new Error(`Profile configuration must use schema ${PROFILE_SCHEMA}.`);
    }
    const selectedProfile = profileConfig.profiles?.[profileName];
    const criticalProfile = profileConfig.profiles?.['tauri-critical'];
    if (!selectedProfile) {
        throw new Error(`Unknown Tauri frontend profile "${profileName}".`);
    }
    if (!criticalProfile || !Array.isArray(criticalProfile.roots)) {
        throw new Error('Profile configuration must declare tauri-critical roots.');
    }
    if (Object.hasOwn(profileConfig, 'deferredGroups')) {
        throw new Error('Profile configuration must use featureGroups; deferredGroups is ambiguous and unsupported.');
    }
    const browserDependencies = browserManifest?.dependencies ?? {};
    const roots = selectedProfile.includeAllBrowserRoots === true
        ? Object.keys(browserDependencies).sort(compareText)
        : [...new Set(selectedProfile.roots ?? [])].sort(compareText);
    const criticalRoots = [...new Set(criticalProfile.roots)].sort(compareText);

    const resolveManifestClosure = (closureRoots, label) => {
        if (closureRoots.length === 0) {
            throw new Error(`Tauri frontend profile "${label}" has no roots.`);
        }
        for (const root of closureRoots) {
            if (!Object.hasOwn(browserDependencies, root) || !Object.hasOwn(packageManifests, root)) {
                throw new Error(`Unknown profile root "${root}".`);
            }
        }
        const visited = new Set();
        const rootSet = new Set(closureRoots);
        const dependenciesByNode = new Map();
        const firstPath = new Map();
        const visit = (requestName, parentSpec, ancestry) => {
            const dependencyPath = [...ancestry, requestName];
            const manifest = packageManifests[requestName];
            if (!manifest) {
                throw new Error(`${dependencyPath.join(' -> ')}: required dependency is not installed.`);
            }
            if (rootSet.has(requestName)) {
                validateInstalledManifest(
                    requestName,
                    browserDependencies[requestName],
                    manifest,
                    dependencyPath,
                    'browser manifest',
                );
            }
            if (ancestry.length > 0) {
                validateInstalledManifest(
                    requestName,
                    parentSpec,
                    manifest,
                    dependencyPath,
                    'parent dependency',
                    isTheiaExtension(manifest),
                );
            }
            if (!firstPath.has(requestName)) {
                firstPath.set(requestName, dependencyPath);
            }
            if (visited.has(requestName)) {
                return;
            }
            visited.add(requestName);
            const dependencies = new Set();
            dependenciesByNode.set(requestName, dependencies);
            for (const [dependencyName, dependency] of dependencyEntries(manifest)) {
                const installed = packageManifests[dependencyName];
                if (!installed && dependency.optional) {
                    continue;
                }
                if (!installed) {
                    throw new Error(`${[...dependencyPath, dependencyName].join(' -> ')}: required dependency is not installed.`);
                }
                dependencies.add(dependencyName);
                visit(dependencyName, dependency.spec, dependencyPath);
            }
        };
        for (const root of closureRoots) {
            visit(root, browserDependencies[root], []);
        }
        return {
            visited,
            dependenciesByNode,
            firstPathByNode: firstPath,
            firstPathByRequest: firstPath,
            requestNames: visited,
        };
    };

    const resolveGraphClosure = (closureRoots, label) => {
        if (closureRoots.length === 0) {
            throw new Error(`Tauri frontend profile "${label}" has no roots.`);
        }
        const visited = new Set();
        const dependenciesByNode = new Map();
        const firstPathByNode = new Map();
        const firstPathByRequest = new Map();
        const requestNames = new Set();
        const visit = (nodeId, ancestry) => {
            const record = installedGraph.records.get(nodeId);
            if (!record) {
                throw new Error(`${ancestry.join(' -> ')}: installed graph node is missing.`);
            }
            const dependencyPath = [...ancestry, record.requestName];
            if (!firstPathByNode.has(nodeId)) {
                firstPathByNode.set(nodeId, dependencyPath);
            }
            if (!firstPathByRequest.has(record.requestName)) {
                firstPathByRequest.set(record.requestName, dependencyPath);
            }
            requestNames.add(record.requestName);
            if (visited.has(nodeId)) {
                return;
            }
            visited.add(nodeId);
            const dependencies = new Set(installedGraph.dependenciesByNode.get(nodeId) ?? []);
            dependenciesByNode.set(nodeId, dependencies);
            for (const dependency of [...dependencies].sort(compareText)) {
                visit(dependency, dependencyPath);
            }
        };
        for (const root of closureRoots) {
            const nodeId = installedGraph.rootNodeIds.get(root);
            if (!nodeId) {
                throw new Error(`Unknown profile root "${root}".`);
            }
            visit(nodeId, []);
        }
        return { visited, dependenciesByNode, firstPathByNode, firstPathByRequest, requestNames };
    };

    const resolveClosure = installedGraph ? resolveGraphClosure : resolveManifestClosure;

    const criticalClosure = resolveClosure(criticalRoots, 'tauri-critical');
    const selectedClosure = profileName === 'tauri-critical'
        ? criticalClosure
        : resolveClosure(roots, profileName);
    const featureGroups = normalizedFeatureGroups(profileConfig.featureGroups, browserDependencies);
    const resolvedFeatureGroups = {};
    for (const [groupName, group] of Object.entries(featureGroups)) {
        const blockedRoots = group.blockedRoots.map(entry => {
            if (!criticalClosure.requestNames.has(entry.name)) {
                throw new Error(`Blocked root "${entry.name}" from group "${groupName}" is not in the critical closure.`);
            }
            const dependencyPath = criticalClosure.firstPathByRequest.get(entry.name);
            if (!Array.isArray(dependencyPath) || dependencyPath.length === 0 || !criticalRoots.includes(dependencyPath[0])) {
                throw new Error(`Blocked root "${entry.name}" from group "${groupName}" is missing a critical dependency path.`);
            }
            return { ...entry, dependencyPath };
        });
        for (const deferredRoot of group.deferredRoots) {
            if (criticalClosure.requestNames.has(deferredRoot)) {
                throw new Error(`Deferred root "${deferredRoot}" from group "${groupName}" is required by the critical dependency path ${criticalClosure.firstPathByRequest.get(deferredRoot).join(' -> ')}.`);
            }
        }
        resolvedFeatureGroups[groupName] = {
            deferredRoots: group.deferredRoots,
            blockedRoots,
        };
    }

    const closure = stableStronglyConnectedOrder(selectedClosure.visited, selectedClosure.dependenciesByNode);
    const extensions = [];
    const packages = [];
    const emittedExtensions = new Set();
    for (const node of closure) {
        const record = installedGraph?.records.get(node);
        const requestName = record?.requestName ?? node;
        const manifest = record?.manifest ?? packageManifests[requestName];
        if (isTheiaExtension(manifest) && !emittedExtensions.has(requestName)) {
            emittedExtensions.add(requestName);
            extensions.push(requestName);
        }
        packages.push({
            requestName,
            packageName: manifest.name,
            version: manifest.version,
            dependencyPath: selectedClosure.firstPathByNode.get(node),
        });
    }
    const contract = {
        schema: PROFILE_SCHEMA,
        profile: profileName,
        roots,
        extensions,
        packages,
        featureGroups: resolvedFeatureGroups,
    };
    return { ...contract, digest: canonicalDigest(contract) };
}

function assertProfilePath(browserDirectory, candidate) {
    const relative = path.relative(path.resolve(browserDirectory), path.resolve(candidate));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Profile path must stay inside the browser application directory.');
    }
}

function assertPathSegment(value, label) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
        || value === '.' || value === '..') {
        throw new Error(`${label} is not canonical.`);
    }
}

export function createDirectoryTransactionPlan(parentDirectory, targetName, transactionId) {
    assertPathSegment(targetName, 'Directory transaction target name');
    assertPathSegment(transactionId, 'Directory transaction id');
    const resolvedParent = path.resolve(parentDirectory);
    const targetDirectory = path.join(resolvedParent, targetName);
    const temporaryDirectory = path.join(resolvedParent, `.${targetName}.tmp-${transactionId}`);
    const backupDirectory = path.join(resolvedParent, `.${targetName}.old-${transactionId}`);
    const markerPath = path.join(resolvedParent, `.${targetName}.transaction-${transactionId}.json`);
    for (const candidate of [targetDirectory, temporaryDirectory, backupDirectory, markerPath]) {
        assertProfilePath(resolvedParent, candidate);
    }
    return {
        parentDirectory: resolvedParent,
        targetName,
        transactionId,
        targetDirectory,
        temporaryDirectory,
        backupDirectory,
        markerPath,
    };
}

const defaultSleep = delay => new Promise(resolve => setTimeout(resolve, delay));

export async function retryFilesystemOperation(operation, {
    platform = process.platform,
    maxAttempts = 5,
    delayMs = 25,
    sleep = defaultSleep,
} = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            const retryable = platform === 'win32' && (error?.code === 'EPERM' || error?.code === 'EBUSY');
            if (!retryable || attempt === maxAttempts) {
                throw error;
            }
            await sleep(delayMs * attempt);
        }
    }
    throw new Error('Filesystem retry exhausted unexpectedly.');
}

async function pathState(candidate, filesystem) {
    try {
        const stat = await filesystem.lstat(candidate);
        return { exists: true, stat };
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { exists: false };
        }
        throw error;
    }
}

function filesystemOptions(options = {}) {
    return {
        filesystem: options.filesystem ?? fs.promises,
        retry: {
            platform: options.platform,
            maxAttempts: options.maxAttempts,
            delayMs: options.delayMs,
            sleep: options.sleep,
        },
    };
}

async function retryRename(filesystem, source, destination, retry) {
    return retryFilesystemOperation(() => filesystem.rename(source, destination), retry);
}

async function retryRemove(filesystem, candidate, retry) {
    const state = await pathState(candidate, filesystem);
    if (!state.exists) {
        return;
    }
    if (state.stat.isSymbolicLink()) {
        throw new Error(`Refusing to remove symbolic transaction path: ${candidate}`);
    }
    return retryFilesystemOperation(() => filesystem.rm(candidate, { recursive: true, force: false }), retry);
}

async function retryUnlink(filesystem, candidate, retry) {
    return retryFilesystemOperation(() => filesystem.unlink(candidate), retry).catch(error => {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    });
}

function transactionMarker(plan, state) {
    return {
        schema: 'ride.directory-transaction@1',
        targetName: plan.targetName,
        transactionId: plan.transactionId,
        state,
    };
}

async function writeTransactionMarker(plan, state, filesystem) {
    const existing = await pathState(plan.markerPath, filesystem);
    if (existing.exists && existing.stat.isSymbolicLink()) {
        throw new Error(`Refusing symbolic transaction marker: ${plan.markerPath}`);
    }
    await filesystem.writeFile(plan.markerPath, `${JSON.stringify(transactionMarker(plan, state))}\n`, { flag: 'w' });
}

function parseTransactionMarker(text, plan) {
    let marker;
    try {
        marker = JSON.parse(text);
    } catch (error) {
        throw new Error(`Malformed directory transaction marker ${plan.markerPath}: ${error.message}`);
    }
    const exactKeys = ['schema', 'state', 'targetName', 'transactionId'];
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)
        || Object.keys(marker).sort(compareText).join('\0') !== exactKeys.join('\0')
        || marker.schema !== 'ride.directory-transaction@1'
        || marker.targetName !== plan.targetName
        || marker.transactionId !== plan.transactionId
        || !['prepared', 'backed-up', 'installed', 'rolled-back'].includes(marker.state)) {
        throw new Error(`Invalid directory transaction marker ${plan.markerPath}.`);
    }
    return marker;
}

async function assertRegularDirectoryIfPresent(candidate, filesystem) {
    const state = await pathState(candidate, filesystem);
    if (state.exists && (!state.stat.isDirectory() || state.stat.isSymbolicLink())) {
        throw new Error(`Directory transaction path is not a regular directory: ${candidate}`);
    }
    return state.exists;
}

export async function recoverDirectoryTransactions({ parentDirectory, targetName }, options = {}) {
    assertPathSegment(targetName, 'Directory transaction target name');
    const resolvedParent = path.resolve(parentDirectory);
    const { filesystem, retry } = filesystemOptions(options);
    let entries;
    try {
        entries = await filesystem.readdir(resolvedParent, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') {
            return;
        }
        throw error;
    }
    const prefix = `.${targetName}.transaction-`;
    const suffix = '.json';
    for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
        if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) {
            continue;
        }
        const transactionId = entry.name.slice(prefix.length, -suffix.length);
        const plan = createDirectoryTransactionPlan(resolvedParent, targetName, transactionId);
        const marker = parseTransactionMarker(await filesystem.readFile(plan.markerPath, 'utf8'), plan);
        const targetExists = await assertRegularDirectoryIfPresent(plan.targetDirectory, filesystem);
        const backupExists = await assertRegularDirectoryIfPresent(plan.backupDirectory, filesystem);
        await assertRegularDirectoryIfPresent(plan.temporaryDirectory, filesystem);
        if (marker.state === 'backed-up') {
            if (targetExists || !backupExists) {
                throw new Error(`Cannot safely recover backed-up directory transaction ${transactionId}.`);
            }
            await retryRename(filesystem, plan.backupDirectory, plan.targetDirectory, retry);
            await retryRemove(filesystem, plan.temporaryDirectory, retry);
            await retryUnlink(filesystem, plan.markerPath, retry);
            continue;
        }
        if (marker.state === 'installed') {
            if (!targetExists) {
                throw new Error(`Cannot safely recover installed directory transaction ${transactionId}.`);
            }
            await retryRemove(filesystem, plan.backupDirectory, retry);
            await retryRemove(filesystem, plan.temporaryDirectory, retry);
            await retryUnlink(filesystem, plan.markerPath, retry);
            continue;
        }
        if (backupExists && !targetExists) {
            await retryRename(filesystem, plan.backupDirectory, plan.targetDirectory, retry);
        } else if (backupExists) {
            throw new Error(`Cannot safely recover directory transaction ${transactionId} with two originals.`);
        }
        await retryRemove(filesystem, plan.temporaryDirectory, retry);
        await retryUnlink(filesystem, plan.markerPath, retry);
    }
}

export async function replaceDirectoryTransactional(plan, options = {}) {
    const expected = createDirectoryTransactionPlan(plan.parentDirectory, plan.targetName, plan.transactionId);
    for (const field of ['targetDirectory', 'temporaryDirectory', 'backupDirectory', 'markerPath']) {
        if (path.resolve(plan[field]) !== path.resolve(expected[field])) {
            throw new Error(`Directory transaction ${field} is not canonical.`);
        }
    }
    const { filesystem, retry } = filesystemOptions(options);
    await recoverDirectoryTransactions({ parentDirectory: plan.parentDirectory, targetName: plan.targetName }, options);
    if (!await assertRegularDirectoryIfPresent(plan.temporaryDirectory, filesystem)) {
        throw new Error(`Directory transaction source is missing: ${plan.temporaryDirectory}`);
    }
    const targetExists = await assertRegularDirectoryIfPresent(plan.targetDirectory, filesystem);
    if (await assertRegularDirectoryIfPresent(plan.backupDirectory, filesystem)) {
        throw new Error(`Directory transaction backup already exists: ${plan.backupDirectory}`);
    }
    await writeTransactionMarker(plan, 'prepared', filesystem);
    if (targetExists) {
        await retryRename(filesystem, plan.targetDirectory, plan.backupDirectory, retry);
        await writeTransactionMarker(plan, 'backed-up', filesystem);
    }
    try {
        await retryRename(filesystem, plan.temporaryDirectory, plan.targetDirectory, retry);
    } catch (installError) {
        if (!targetExists) {
            throw installError;
        }
        try {
            await retryRename(filesystem, plan.backupDirectory, plan.targetDirectory, retry);
            await writeTransactionMarker(plan, 'rolled-back', filesystem);
            await retryUnlink(filesystem, plan.markerPath, retry);
        } catch (rollbackError) {
            throw new AggregateError([installError, rollbackError], 'Directory install and rollback both failed.');
        }
        throw installError;
    }
    await writeTransactionMarker(plan, 'installed', filesystem);
    await retryRemove(filesystem, plan.backupDirectory, retry);
    await retryUnlink(filesystem, plan.markerPath, retry);
}

async function copyRegularTree(source, destination) {
    const sourceStat = await fs.promises.lstat(source);
    if (sourceStat.isSymbolicLink()) {
        throw new Error(`Refusing to copy symbolic link into profile target: ${source}`);
    }
    if (sourceStat.isFile()) {
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await fs.promises.copyFile(source, destination);
        return;
    }
    if (!sourceStat.isDirectory()) {
        throw new Error(`Refusing to copy non-regular profile asset: ${source}`);
    }
    await fs.promises.mkdir(destination, { recursive: true });
    const entries = await fs.promises.readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
        await copyRegularTree(path.join(source, entry.name), path.join(destination, entry.name));
    }
}

export function findPackageManifest(packageEntry) {
    let directory = path.dirname(packageEntry);
    while (true) {
        const candidate = path.join(directory, 'package.json');
        if (fs.existsSync(candidate)) {
            try {
                const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
                if (typeof manifest.name === 'string' && manifest.name && semver.valid(manifest.version)) {
                    return candidate;
                }
            } catch {
                // Nested package metadata may describe only the module format.
                // Continue upward until a canonical package identity is found.
            }
        }
        const parent = path.dirname(directory);
        if (parent === directory) {
            throw new Error(`Unable to locate package manifest for ${packageEntry}.`);
        }
        directory = parent;
    }
}

export function selectCanonicalPackageManifest(manifestPath) {
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (typeof manifest.name === 'string' && manifest.name && semver.valid(manifest.version)) {
            return manifestPath;
        }
    } catch {
        // A package export can resolve to nested or incomplete metadata. Search
        // upward for the manifest that carries the installed package identity.
    }
    return findPackageManifest(manifestPath);
}

async function defaultResolveInstalledManifest(requestName, fromDirectory) {
    const localRequire = createRequire(path.join(fromDirectory, 'package.json'));
    let manifestPath;
    try {
        manifestPath = localRequire.resolve(`${requestName}/package.json`);
    } catch {
        const entry = localRequire.resolve(requestName);
        manifestPath = findPackageManifest(entry);
    }
    manifestPath = selectCanonicalPackageManifest(manifestPath);
    return {
        requestName,
        packageDirectory: path.dirname(manifestPath),
        manifest: JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')),
    };
}

export async function resolveInstalledPackageGraph({ browserManifest, roots, resolver, browserDirectory }) {
    const records = new Map();
    const dependenciesByNode = new Map();
    const rootNodeIds = new Map();
    const extensionRecords = new Map();
    const rootSet = new Set(roots);
    const load = async (requestName, spec, fromDirectory, dependencyPath, optional = false) => {
        const expected = parseDependencySpec(requestName, spec);
        if (!semver.validRange(expected.range)) {
            throw new Error(`${dependencyPath.join(' -> ')}: dependency "${requestName}" has invalid dependency range "${expected.range}".`);
        }
        let installed;
        try {
            installed = await resolver(requestName, fromDirectory);
        } catch (error) {
            if (optional) {
                return;
            }
            throw new Error(`${dependencyPath.join(' -> ')}: required dependency is not installed: ${error.message}`);
        }
        if (!installed || typeof installed.packageDirectory !== 'string' || !path.isAbsolute(installed.packageDirectory)) {
            throw new Error(`${dependencyPath.join(' -> ')}: installed dependency has no package directory.`);
        }
        validateInstalledManifest(
            requestName,
            spec,
            installed.manifest,
            dependencyPath,
            'parent dependency',
            rootSet.has(requestName) || isTheiaExtension(installed.manifest),
        );
        if (rootSet.has(requestName)) {
            validateInstalledManifest(
                requestName,
                browserManifest.dependencies[requestName],
                installed.manifest,
                dependencyPath,
                'browser manifest',
            );
        }
        const nodeId = canonicalDigest({
            requestName,
            packageName: installed.manifest.name,
            version: installed.manifest.version,
        });
        const existingExtension = extensionRecords.get(requestName);
        if (isTheiaExtension(installed.manifest) && existingExtension && existingExtension.nodeId !== nodeId) {
            throw new Error(
                `Conflicting installed extension identity for "${requestName}": `
                + `${existingExtension.dependencyPath.join(' -> ')} resolved ${existingExtension.manifest.name}@${existingExtension.manifest.version}, `
                + `but ${dependencyPath.join(' -> ')} resolved ${installed.manifest.name}@${installed.manifest.version}.`,
            );
        }
        const existing = records.get(nodeId);
        if (existing) {
            if (existing.manifest.name !== installed.manifest.name || existing.manifest.version !== installed.manifest.version
                || existing.requestName !== requestName) {
                throw new Error(
                    `Conflicting installed identity for "${requestName}": `
                    + `${existing.dependencyPath.join(' -> ')} resolved ${existing.manifest.name}@${existing.manifest.version}, `
                    + `but ${dependencyPath.join(' -> ')} resolved ${installed.manifest.name}@${installed.manifest.version}.`,
                );
            }
            return nodeId;
        }
        const record = {
            nodeId,
            requestName,
            packageDirectory: path.resolve(installed.packageDirectory),
            manifest: installed.manifest,
            dependencyPath,
        };
        records.set(nodeId, record);
        dependenciesByNode.set(nodeId, new Set());
        if (isTheiaExtension(installed.manifest)) {
            extensionRecords.set(requestName, record);
        }
        for (const [dependencyName, dependency] of dependencyEntries(installed.manifest)) {
            const dependencyNode = await load(
                dependencyName,
                dependency.spec,
                record.packageDirectory,
                [...dependencyPath, dependencyName],
                dependency.optional,
            );
            if (dependencyNode) {
                dependenciesByNode.get(nodeId).add(dependencyNode);
            }
        }
        return nodeId;
    };
    for (const root of roots) {
        const spec = browserManifest.dependencies?.[root];
        if (typeof spec !== 'string') {
            throw new Error(`Unknown profile root "${root}".`);
        }
        rootNodeIds.set(root, await load(root, spec, browserDirectory, [root]));
    }
    return { records, dependenciesByNode, rootNodeIds, extensionRecords };
}

function selectedRoots(profileName, profileConfig, browserManifest) {
    const profile = profileConfig.profiles?.[profileName];
    if (!profile) {
        throw new Error(`Unknown Tauri frontend profile "${profileName}".`);
    }
    return profile.includeAllBrowserRoots === true
        ? Object.keys(browserManifest.dependencies ?? {}).sort(compareText)
        : [...new Set(profile.roots ?? [])].sort(compareText);
}

function generatedExtensionSpec(requestName, browserManifest, record, rootSet) {
    if (rootSet.has(requestName)) {
        return browserManifest.dependencies[requestName];
    }
    return requestName === record.manifest.name
        ? record.manifest.version
        : `npm:${record.manifest.name}@${record.manifest.version}`;
}

async function linkInstalledPackage(targetDirectory, requestName, packageDirectory) {
    const segments = requestName.startsWith('@') ? requestName.split('/') : [requestName];
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
        throw new Error(`Cannot link non-canonical package request "${requestName}".`);
    }
    const linkPath = path.join(targetDirectory, 'node_modules', ...segments);
    await fs.promises.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.promises.symlink(packageDirectory, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

async function verifyGeneratedExtensions(targetDirectory, dependencies, records) {
    for (const [requestName, spec] of Object.entries(dependencies).sort(([left], [right]) => compareText(left, right))) {
        const installed = await defaultResolveInstalledManifest(requestName, targetDirectory);
        validateInstalledManifest(requestName, spec, installed.manifest, [requestName], 'generated application');
        const expected = records.get(requestName);
        if (!expected || expected.manifest.name !== installed.manifest.name || expected.manifest.version !== installed.manifest.version) {
            throw new Error(`Generated application resolved an unexpected identity for "${requestName}".`);
        }
    }
}

export async function generateProfileTarget({
    browserDirectory,
    profileName = 'tauri-critical',
    buildId,
    sourceIdentity = defaultSourceIdentity,
    resolveInstalledManifest = defaultResolveInstalledManifest,
} = {}) {
    const resolvedBrowserDirectory = path.resolve(browserDirectory);
    assertPathSegment(buildId, 'Tauri profile build id');
    const identity = validateSourceIdentity(await sourceIdentity());
    const browserManifest = JSON.parse(await fs.promises.readFile(path.join(resolvedBrowserDirectory, 'package.json'), 'utf8'));
    const profileConfig = JSON.parse(await fs.promises.readFile(path.join(resolvedBrowserDirectory, 'tauri-profile.json'), 'utf8'));
    const roots = selectedRoots(profileName, profileConfig, browserManifest);
    const installedGraph = await resolveInstalledPackageGraph({
        browserManifest,
        roots,
        resolver: resolveInstalledManifest,
        browserDirectory: resolvedBrowserDirectory,
    });
    for (const devDependency of profileConfig.buildDevDependencies ?? []) {
        const installed = await resolveInstalledManifest(devDependency, resolvedBrowserDirectory);
        validateInstalledManifest(devDependency, browserManifest.devDependencies?.[devDependency], installed.manifest, [devDependency]);
    }
    const resolved = resolveProfile({ profileName, profileConfig, browserManifest, installedGraph });
    const buildsDirectory = path.join(resolvedBrowserDirectory, PROFILE_DIRECTORY_NAME, 'builds');
    await fs.promises.mkdir(buildsDirectory, { recursive: true });
    await recoverDirectoryTransactions({ parentDirectory: buildsDirectory, targetName: buildId });
    if ((await pathState(path.join(buildsDirectory, buildId), fs.promises)).exists) {
        throw new Error(`Tauri profile build id "${buildId}" already exists and is immutable.`);
    }
    const transactionId = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const plan = createDirectoryTransactionPlan(buildsDirectory, buildId, transactionId);
    await retryRemove(fs.promises, plan.temporaryDirectory, {});
    await fs.promises.mkdir(plan.temporaryDirectory, { recursive: true });
    try {
        const rootSet = new Set(roots);
        const dependencies = Object.fromEntries(resolved.extensions.map(name => [
            name,
            generatedExtensionSpec(name, browserManifest, installedGraph.extensionRecords.get(name), rootSet),
        ]));
        const devDependencies = Object.fromEntries((profileConfig.buildDevDependencies ?? []).map(name => {
            const spec = browserManifest.devDependencies?.[name];
            if (!spec) {
                throw new Error(`Build dev dependency "${name}" is not declared by the browser application.`);
            }
            return [name, spec];
        }));
        const generatedPackage = {
            private: true,
            name: `${browserManifest.name}-${profileName}`,
            version: browserManifest.version,
            license: browserManifest.license,
            engines: browserManifest.engines,
            theia: browserManifest.theia,
            dependencies,
            devDependencies,
        };
        await fs.promises.writeFile(path.join(plan.temporaryDirectory, 'package.json'), `${JSON.stringify(generatedPackage, null, 2)}\n`);
        for (const requestName of resolved.extensions) {
            await linkInstalledPackage(
                plan.temporaryDirectory,
                requestName,
                installedGraph.extensionRecords.get(requestName).packageDirectory,
            );
        }
        for (const file of CUSTOM_FILES) {
            await copyRegularTree(path.join(resolvedBrowserDirectory, file), path.join(plan.temporaryDirectory, file));
        }
        for (const directory of CUSTOM_DIRECTORIES) {
            const source = path.join(resolvedBrowserDirectory, directory);
            if (fs.existsSync(source)) {
                await copyRegularTree(source, path.join(plan.temporaryDirectory, directory));
            }
        }
        const profileManifest = {
            schema: 'ride.tauri-profile',
            version: 1,
            commit: identity.commit,
            sourceIdentity: identity,
            buildId,
            profile: resolved.profile,
            digest: resolved.digest,
            roots: resolved.roots,
            extensions: resolved.extensions,
            packages: resolved.packages,
            featureGroups: resolved.featureGroups,
        };
        await fs.promises.writeFile(path.join(plan.temporaryDirectory, PROFILE_MANIFEST_NAME), `${JSON.stringify(profileManifest, null, 2)}\n`);
        await verifyGeneratedExtensions(plan.temporaryDirectory, dependencies, installedGraph.extensionRecords);
        await replaceDirectoryTransactional(plan);
    } catch (error) {
        await retryRemove(fs.promises, plan.temporaryDirectory, {}).catch(() => {});
        throw error;
    }
    return { ...resolved, buildId, sourceIdentity: identity, targetDirectory: plan.targetDirectory };
}

function assertExactObjectFields(value, fields, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object with exact manifest fields.`);
    }
    const actual = Object.keys(value).sort(compareText);
    const expected = [...fields].sort(compareText);
    if (actual.join('\0') !== expected.join('\0')) {
        const unexpected = actual.filter(field => !expected.includes(field));
        throw new Error(`${label} has invalid manifest fields${unexpected.length ? `: unsupported ${unexpected.join(', ')}` : ''}.`);
    }
}

function validateStringArray(value, label) {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item || item !== item.trim())) {
        throw new Error(`${label} must contain canonical package names.`);
    }
    if (new Set(value).size !== value.length) {
        throw new Error(`${label} must not contain duplicate package names.`);
    }
}

function validateProfileBuildManifest(manifestText, { expectedProfile, buildId, identity }) {
    let manifest;
    try {
        manifest = JSON.parse(manifestText);
    } catch (error) {
        throw new Error(`Tauri profile manifest is malformed: ${error.message}`);
    }
    assertExactObjectFields(manifest, [
        'schema',
        'version',
        'commit',
        'sourceIdentity',
        'buildId',
        'profile',
        'digest',
        'roots',
        'extensions',
        'packages',
        'featureGroups',
    ], 'Tauri profile manifest');
    if (manifest.schema !== 'ride.tauri-profile' || manifest.version !== 1) {
        throw new Error('Tauri profile manifest schema must be ride.tauri-profile@1.');
    }
    assertExactObjectFields(manifest.sourceIdentity, ['commit', 'clean'], 'Tauri profile source identity');
    const manifestIdentity = validateSourceIdentity(manifest.sourceIdentity);
    if (manifest.profile !== expectedProfile) {
        throw new Error(`Tauri profile mismatch: expected "${expectedProfile}", found "${manifest.profile}".`);
    }
    if (manifest.buildId !== buildId) {
        throw new Error(`Tauri profile build id mismatch: expected "${buildId}", found "${manifest.buildId}".`);
    }
    if (manifest.commit !== manifestIdentity.commit || manifest.commit !== identity.commit) {
        throw new Error(`Tauri profile commit mismatch: build ${manifest.commit} is stale for current commit ${identity.commit}.`);
    }
    validateStringArray(manifest.roots, 'Tauri profile roots');
    validateStringArray(manifest.extensions, 'Tauri profile extensions');
    if (!Array.isArray(manifest.packages)) {
        throw new Error('Tauri profile packages must be an array.');
    }
    for (const record of manifest.packages) {
        assertExactObjectFields(record, ['requestName', 'packageName', 'version', 'dependencyPath'], 'Tauri profile package');
        if (typeof record.requestName !== 'string' || !record.requestName
            || typeof record.packageName !== 'string' || !record.packageName
            || !semver.valid(record.version)) {
            throw new Error('Tauri profile package identity is invalid.');
        }
        validateStringArray(record.dependencyPath, `Tauri profile package ${record.requestName} dependency path`);
    }
    if (!manifest.featureGroups || typeof manifest.featureGroups !== 'object' || Array.isArray(manifest.featureGroups)) {
        throw new Error('Tauri profile feature groups must be an object.');
    }
    if (!/^[0-9a-f]{64}$/.test(manifest.digest ?? '')) {
        throw new Error('Tauri profile digest is not canonical.');
    }
    const contract = {
        schema: PROFILE_SCHEMA,
        profile: manifest.profile,
        roots: manifest.roots,
        extensions: manifest.extensions,
        packages: manifest.packages,
        featureGroups: manifest.featureGroups,
    };
    const digest = canonicalDigest(contract);
    if (digest !== manifest.digest) {
        throw new Error(`Tauri profile digest mismatch: expected ${digest}, found ${manifest.digest}.`);
    }
    return manifest;
}

function canonicalBuildSource(browserDirectory, buildId) {
    return path.join(path.resolve(browserDirectory), PROFILE_DIRECTORY_NAME, 'builds', buildId);
}

function defaultIsProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

function parsePublishLockOwner(text, lockDirectory) {
    let owner;
    try {
        owner = JSON.parse(text);
    } catch (error) {
        throw new Error(`Malformed Tauri publish lock owner in ${lockDirectory}: ${error.message}`);
    }
    assertExactObjectFields(owner, ['schema', 'pid', 'buildId', 'profile', 'commit', 'acquiredAt'], 'Tauri publish lock owner');
    if (owner.schema !== 'ride.tauri-publish-lock@1'
        || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
        || !Number.isFinite(owner.acquiredAt) || owner.acquiredAt < 0
        || !/^[0-9a-f]{40}$/.test(owner.commit ?? '')) {
        throw new Error(`Invalid Tauri publish lock owner in ${lockDirectory}.`);
    }
    assertPathSegment(owner.buildId, 'Tauri publish lock build id');
    if (typeof owner.profile !== 'string' || !owner.profile || owner.profile !== owner.profile.trim()) {
        throw new Error(`Invalid Tauri publish lock profile in ${lockDirectory}.`);
    }
    return owner;
}

async function readPublishLockOwner(lockDirectory, filesystem) {
    const ownerPath = path.join(lockDirectory, 'owner.json');
    const ownerState = await pathState(ownerPath, filesystem);
    if (!ownerState.exists) {
        throw Object.assign(new Error(`Tauri publish lock owner is not initialized in ${lockDirectory}.`), { code: 'ENOENT' });
    }
    if (!ownerState.stat.isFile() || ownerState.stat.isSymbolicLink()) {
        throw new Error(`Refusing unsafe Tauri publish lock owner path: ${ownerPath}`);
    }
    return parsePublishLockOwner(await filesystem.readFile(ownerPath, 'utf8'), lockDirectory);
}

export async function acquirePublishLock({
    browserDirectory,
    owner,
    filesystem = fs.promises,
    now = Date.now,
    sleep = defaultSleep,
    timeoutMs = 30_000,
    retryDelayMs = 50,
    staleMs = 5 * 60_000,
    isProcessAlive = defaultIsProcessAlive,
    platform = process.platform,
} = {}) {
    const resolvedBrowserDirectory = path.resolve(browserDirectory);
    assertPathSegment(owner?.buildId, 'Tauri publish lock build id');
    if (typeof owner?.profile !== 'string' || !owner.profile || !/^[0-9a-f]{40}$/.test(owner.commit ?? '')) {
        throw new Error('Tauri publish lock owner identity is invalid.');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(staleMs) || staleMs < 0
        || !Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
        throw new Error('Tauri publish lock timing is invalid.');
    }
    const lockDirectory = path.join(resolvedBrowserDirectory, '.ride-tauri-publish.lock');
    assertProfilePath(resolvedBrowserDirectory, lockDirectory);
    const startedAt = now();
    while (true) {
        const acquiredAt = now();
        const lockOwner = {
            schema: 'ride.tauri-publish-lock@1',
            pid: process.pid,
            buildId: owner.buildId,
            profile: owner.profile,
            commit: owner.commit,
            acquiredAt,
        };
        try {
            await filesystem.mkdir(lockDirectory);
            try {
                await filesystem.writeFile(path.join(lockDirectory, 'owner.json'), `${JSON.stringify(lockOwner)}\n`, { flag: 'wx' });
            } catch (error) {
                await retryRemove(filesystem, lockDirectory, { platform, sleep }).catch(() => {});
                throw error;
            }
            return async () => {
                const current = await readPublishLockOwner(lockDirectory, filesystem);
                if (current.pid !== lockOwner.pid || current.buildId !== lockOwner.buildId
                    || current.profile !== lockOwner.profile || current.commit !== lockOwner.commit
                    || current.acquiredAt !== lockOwner.acquiredAt) {
                    throw new Error('Tauri publish lock ownership changed before release.');
                }
                await retryRemove(filesystem, lockDirectory, { platform, sleep });
            };
        } catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }
        }

        const state = await pathState(lockDirectory, filesystem);
        if (!state.exists) {
            continue;
        }
        if (!state.stat.isDirectory() || state.stat.isSymbolicLink()) {
            throw new Error(`Refusing unsafe Tauri publish lock path: ${lockDirectory}`);
        }
        const currentTime = now();
        let currentOwner;
        try {
            currentOwner = await readPublishLockOwner(lockDirectory, filesystem);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
            if (currentTime - startedAt >= timeoutMs) {
                throw new Error('Timed out waiting for Tauri publish lock owner initialization.');
            }
            await sleep(retryDelayMs);
            continue;
        }
        if (currentTime - currentOwner.acquiredAt >= staleMs && !isProcessAlive(currentOwner.pid)) {
            const staleDirectory = path.join(
                resolvedBrowserDirectory,
                `.ride-tauri-publish.lock.stale-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
            );
            assertProfilePath(resolvedBrowserDirectory, staleDirectory);
            try {
                await retryRename(filesystem, lockDirectory, staleDirectory, { platform, sleep });
            } catch (error) {
                if (error.code === 'ENOENT') {
                    continue;
                }
                throw error;
            }
            await retryRemove(filesystem, staleDirectory, { platform, sleep });
            continue;
        }
        if (currentTime - startedAt >= timeoutMs) {
            throw new Error(`Timed out waiting for Tauri publish lock owned by build "${currentOwner.buildId}".`);
        }
        await sleep(retryDelayMs);
    }
}

export async function publishProfileBuild({
    browserDirectory,
    expectedProfile,
    buildId,
    sourceDirectory,
    sourceIdentity = defaultSourceIdentity,
    copyTree = copyRegularTree,
    lockOptions = {},
    transactionOptions = {},
} = {}) {
    const resolvedBrowserDirectory = path.resolve(browserDirectory);
    assertPathSegment(buildId, 'Tauri profile build id');
    if (typeof expectedProfile !== 'string' || !expectedProfile) {
        throw new Error('Expected Tauri profile is required for publish.');
    }
    const expectedSource = canonicalBuildSource(resolvedBrowserDirectory, buildId);
    if (path.resolve(sourceDirectory ?? '') !== path.resolve(expectedSource)) {
        throw new Error(`Tauri profile source directory is not canonical for build "${buildId}".`);
    }
    const identity = validateSourceIdentity(await sourceIdentity());
    const sourceLib = path.join(expectedSource, 'lib');
    const sourceManifest = path.join(expectedSource, PROFILE_MANIFEST_NAME);
    const destinationLib = path.join(resolvedBrowserDirectory, 'lib');
    const initialManifestText = await fs.promises.readFile(sourceManifest);
    validateProfileBuildManifest(initialManifestText, { expectedProfile, buildId, identity });
    const release = await acquirePublishLock({
        browserDirectory: resolvedBrowserDirectory,
        owner: { buildId, profile: expectedProfile, commit: identity.commit },
        ...lockOptions,
    });
    try {
        const lockedIdentity = validateSourceIdentity(await sourceIdentity());
        if (lockedIdentity.commit !== identity.commit) {
            throw new Error('Tauri profile source identity changed while waiting for the publish lock.');
        }
        const manifestText = await fs.promises.readFile(sourceManifest);
        const manifest = validateProfileBuildManifest(manifestText, {
            expectedProfile,
            buildId,
            identity: lockedIdentity,
        });
        if (!manifestText.equals(initialManifestText)) {
            throw new Error('Tauri profile source manifest changed while waiting for the publish lock.');
        }
        const unique = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
        const plan = createDirectoryTransactionPlan(resolvedBrowserDirectory, 'lib', unique);
        await recoverDirectoryTransactions(
            { parentDirectory: resolvedBrowserDirectory, targetName: 'lib' },
            transactionOptions,
        );
        await retryRemove(fs.promises, plan.temporaryDirectory, {});
        await copyTree(sourceLib, plan.temporaryDirectory);
        await fs.promises.writeFile(path.join(plan.temporaryDirectory, PROFILE_MANIFEST_NAME), manifestText);
        for (const output of ['frontend', 'backend']) {
            await fs.promises.mkdir(path.join(plan.temporaryDirectory, output), { recursive: true });
            await fs.promises.writeFile(path.join(plan.temporaryDirectory, output, PROFILE_MANIFEST_NAME), manifestText);
        }
        await replaceDirectoryTransactional(plan, transactionOptions);
        await retryRemove(fs.promises, expectedSource, {});
        return { profile: manifest.profile, buildId: manifest.buildId, digest: manifest.digest, destinationLib };
    } finally {
        await release();
    }
}

export function parseProfileCliArguments(argv, environment = process.env) {
    const [command, ...tokens] = argv;
    if (command !== 'prepare' && command !== 'publish') {
        throw new Error('Usage: node tauri-frontend-profile.mjs <prepare|publish> --profile <name> --build-id <id> [--source-dir <path>]');
    }
    const values = new Map();
    for (let index = 0; index < tokens.length; index += 2) {
        const option = tokens[index];
        const value = tokens[index + 1];
        if (!['--profile', '--build-id', '--source-dir'].includes(option) || typeof value !== 'string' || !value
            || values.has(option)) {
            throw new Error(`Invalid or duplicate Tauri profile CLI option "${option ?? '<missing>'}".`);
        }
        values.set(option, value);
    }
    const profileName = values.get('--profile') ?? environment.RIDE_TAURI_FRONTEND_PROFILE ?? 'tauri-critical';
    const buildId = values.get('--build-id');
    if (!buildId) {
        throw new Error('Tauri profile CLI requires --build-id.');
    }
    assertPathSegment(buildId, 'Tauri profile build id');
    const sourceDirectory = values.get('--source-dir');
    if (command === 'publish' && !sourceDirectory) {
        throw new Error('Tauri profile publish requires --source-dir.');
    }
    if (command === 'prepare' && sourceDirectory) {
        throw new Error('Tauri profile prepare does not accept --source-dir.');
    }
    return { command, profileName, buildId, sourceDirectory };
}

async function runCli() {
    const { command, profileName, buildId, sourceDirectory } = parseProfileCliArguments(process.argv.slice(2));
    const browserDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'applications', 'browser');
    if (command === 'prepare') {
        const result = await generateProfileTarget({ browserDirectory, profileName, buildId });
        process.stdout.write(`Prepared ${result.profile} profile ${result.digest} at ${result.targetDirectory}\n`);
        return;
    }
    if (command === 'publish') {
        const result = await publishProfileBuild({
            browserDirectory,
            expectedProfile: profileName,
            buildId,
            sourceDirectory,
        });
        process.stdout.write(`Published ${result.profile} build ${result.buildId} frontend and backend bundles.\n`);
        return;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runCli().catch(error => {
        console.error(`Tauri frontend profile failed: ${error.message}`);
        process.exitCode = 1;
    });
}
