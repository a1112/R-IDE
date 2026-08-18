import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const semver = require('semver');
const properLockfile = require('proper-lockfile');

export const PROFILE_SCHEMA = 'ride.tauri-frontend-profile@2';
export const PROFILE_DIRECTORY_NAME = '.ride-tauri-profile';
const PROFILE_MANIFEST_NAME = 'ride-tauri-profile.json';
const CUSTOM_FILES = ['esbuild.mjs', 'ride-esbuild-dedupe.mjs', 'tauri-esbuild-profile-audit.mjs'];
const CUSTOM_DIRECTORIES = ['resources', 'ico', 'tauri-src'];
const PUBLISH_LOCK_STALE_MS = 5_000;
const PUBLISH_LOCK_UPDATE_MS = 2_000;
const PUBLISH_LOCK_RETRY_MS = 250;
const PUBLISH_LOCK_RETRIES = 120;
const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

export function readSourceIdentity(sourceRepository = repositoryDirectory, run = execFileSync) {
    const resolvedRepository = path.resolve(sourceRepository);
    const commit = run('git', ['rev-parse', 'HEAD'], {
        cwd: resolvedRepository,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        maxBuffer: 1024,
    }).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) {
        throw new Error('Current Git commit is not canonical.');
    }
    const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', 'app'], {
        cwd: resolvedRepository,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
        maxBuffer: 1024 * 1024,
    }).trim();
    return { commit, clean: status === '' };
}

async function defaultSourceIdentity() {
    return readSourceIdentity(repositoryDirectory);
}

function validateSourceIdentity(identity) {
    const keys = identity && typeof identity === 'object' && !Array.isArray(identity)
        ? Object.keys(identity).sort(compareText)
        : [];
    if (keys.join('\0') !== ['clean', 'commit'].join('\0')
        || !/^[0-9a-f]{40}$/.test(identity.commit ?? '')
        || identity.clean !== true) {
        throw new Error('The source tree must be clean with a canonical current commit.');
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
    const classifiedFrontendModules = new Set();
    for (const groupName of Object.keys(featureGroups).sort(compareText)) {
        const value = featureGroups[groupName];
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(`Feature group "${groupName}" must be an object.`);
        }
        const unexpectedFields = Object.keys(value).filter(key => (
            key !== 'deferredRoots'
            && key !== 'blockedRoots'
            && key !== 'deferredFrontendModules'
            && key !== 'deferBlockedReason'
        ));
        if (unexpectedFields.length > 0) {
            throw new Error(`Feature group "${groupName}" has unsupported field "${unexpectedFields.sort(compareText)[0]}".`);
        }
        const deferredRoots = value.deferredRoots;
        const blockedRoots = value.blockedRoots;
        const deferredFrontendModules = value.deferredFrontendModules;
        if (!Array.isArray(deferredRoots) || deferredRoots.some(root => typeof root !== 'string' || !root)) {
            throw new Error(`Feature group "${groupName}" must contain exact deferredRoots package names.`);
        }
        if (!Array.isArray(blockedRoots)) {
            throw new Error(`Feature group "${groupName}" must contain blockedRoots evidence entries.`);
        }
        if (deferredFrontendModules !== undefined && !Array.isArray(deferredFrontendModules)) {
            throw new Error(`Feature group "${groupName}" deferredFrontendModules must be an array.`);
        }
        if (value.deferBlockedReason !== undefined
            && (typeof value.deferBlockedReason !== 'string'
                || !value.deferBlockedReason.trim()
                || value.deferBlockedReason !== value.deferBlockedReason.trim())) {
            throw new Error(`Feature group "${groupName}" deferBlockedReason must be canonical.`);
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
        const normalizedFrontendModules = (deferredFrontendModules ?? []).map(entry => {
            const fields = entry && typeof entry === 'object' && !Array.isArray(entry)
                ? Object.keys(entry).sort(compareText)
                : [];
            const expectedFields = ['action', 'entry', 'module', 'package', 'proxy'].sort(compareText);
            if (fields.join('\0') !== expectedFields.join('\0')) {
                throw new Error(`Feature group "${groupName}" has an invalid deferred frontend module entry.`);
            }
            if (!Object.hasOwn(browserDependencies, entry.package)) {
                throw new Error(`Unknown deferred frontend package "${entry.package}" in group "${groupName}".`);
            }
            if (typeof entry.module !== 'string'
                || !entry.module.startsWith(`${entry.package}/`)
                || entry.module.includes('\\')
                || entry.module.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
                throw new Error(`Deferred frontend module in group "${groupName}" must use a canonical module request.`);
            }
            for (const field of ['proxy', 'entry']) {
                const candidate = entry[field];
                if (typeof candidate !== 'string'
                    || !candidate.startsWith('tauri-src/')
                    || candidate.includes('\\')
                    || candidate.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
                    throw new Error(`Deferred frontend module ${field} in group "${groupName}" must use a canonical tauri-src path.`);
                }
            }
            if (typeof entry.action !== 'string' || !entry.action || entry.action !== entry.action.trim()) {
                throw new Error(`Deferred frontend module action in group "${groupName}" must be canonical.`);
            }
            if (classifiedFrontendModules.has(entry.module)) {
                throw new Error(`Deferred frontend module "${entry.module}" is duplicated.`);
            }
            classifiedFrontendModules.add(entry.module);
            return {
                package: entry.package,
                module: entry.module,
                proxy: entry.proxy,
                entry: entry.entry,
                action: entry.action,
            };
        }).sort((left, right) => compareText(left.module, right.module));
        const normalizedGroup = {
            deferredRoots: [...deferredRoots].sort(compareText),
            blockedRoots: normalizedBlocked.sort((left, right) => compareText(left.name, right.name)),
        };
        if (deferredFrontendModules !== undefined) {
            normalizedGroup.deferredFrontendModules = normalizedFrontendModules;
        }
        if (value.deferBlockedReason !== undefined) {
            normalizedGroup.deferBlockedReason = value.deferBlockedReason;
        }
        result[groupName] = normalizedGroup;
    }
    return result;
}

function stableStronglyConnectedOrder(nodes, dependenciesByNode, compareNodes = compareText) {
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

        for (const dependency of [...(dependenciesByNode.get(node) ?? [])].sort(compareNodes)) {
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
            components.push(component.sort(compareNodes));
        }
    };

    for (const node of [...nodes].sort(compareNodes)) {
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
            return compareNodes(components[left][0], components[right][0]);
        });
        dependencies.forEach(visitComponent);
        ordered.push(...components[component]);
    };
    [...components.keys()]
        .sort((left, right) => compareNodes(components[left][0], components[right][0]))
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
        const compareGraphNodes = (left, right) => compareText(
            installedGraph.records.get(left)?.contextSortKey ?? left,
            installedGraph.records.get(right)?.contextSortKey ?? right,
        );
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
            for (const dependency of [...dependencies].sort(compareGraphNodes)) {
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
        return { visited, dependenciesByNode, firstPathByNode, firstPathByRequest, requestNames, compareNodes: compareGraphNodes };
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
        for (const deferredModule of group.deferredFrontendModules ?? []) {
            if (!criticalClosure.requestNames.has(deferredModule.package)) {
                throw new Error(`Deferred frontend package "${deferredModule.package}" from group "${groupName}" must remain in the critical closure.`);
            }
        }
        resolvedFeatureGroups[groupName] = {
            deferredRoots: group.deferredRoots,
            blockedRoots,
        };
        if (group.deferredFrontendModules !== undefined) {
            resolvedFeatureGroups[groupName].deferredFrontendModules = group.deferredFrontendModules;
        }
        if (group.deferBlockedReason !== undefined) {
            resolvedFeatureGroups[groupName].deferBlockedReason = group.deferBlockedReason;
        }
    }

    const closure = stableStronglyConnectedOrder(
        selectedClosure.visited,
        selectedClosure.dependenciesByNode,
        selectedClosure.compareNodes,
    );
    const packages = [];
    const lastExtensionIndex = new Map();
    for (const [index, node] of closure.entries()) {
        const record = installedGraph?.records.get(node);
        const requestName = record?.requestName ?? node;
        const manifest = record?.manifest ?? packageManifests[requestName];
        if (isTheiaExtension(manifest)) {
            lastExtensionIndex.set(requestName, index);
        }
        packages.push({
            requestName,
            packageName: manifest.name,
            version: manifest.version,
            dependencyPath: selectedClosure.firstPathByNode.get(node),
        });
    }
    const extensions = closure.flatMap((node, index) => {
        const record = installedGraph?.records.get(node);
        const requestName = record?.requestName ?? node;
        return lastExtensionIndex.get(requestName) === index ? [requestName] : [];
    });
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
    const markerPrefix = path.join(resolvedParent, `.${targetName}.transaction-${transactionId}.`);
    for (const candidate of [targetDirectory, temporaryDirectory, backupDirectory, markerPath, markerPrefix]) {
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
        markerPrefix,
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

const transactionStates = new Map([
    ['prepared', 1],
    ['backed-up', 2],
    ['installed', 3],
    ['rolled-back', 4],
]);

function transactionMarker(plan, state) {
    return {
        schema: 'ride.directory-transaction@2',
        targetName: plan.targetName,
        transactionId: plan.transactionId,
        state,
        sequence: transactionStates.get(state),
    };
}

function transactionStateMarkerPath(plan, state, nonce) {
    const sequence = String(transactionStates.get(state)).padStart(2, '0');
    return `${plan.markerPrefix}${sequence}-${state}-${nonce}.json`;
}

function transactionTempMarkerPath(plan, nonce) {
    return `${plan.markerPrefix}marker-tmp-${nonce}`;
}

async function syncParentDirectory(parentDirectory, filesystem, platform) {
    let handle;
    try {
        handle = await filesystem.open(parentDirectory, 'r');
        await handle.sync();
    } catch (error) {
        const unsupportedOnWindows = platform === 'win32'
            && ['EACCES', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM'].includes(error?.code);
        if (!unsupportedOnWindows) {
            throw error;
        }
    } finally {
        await handle?.close();
    }
}

async function writeTransactionMarker(plan, state, options) {
    const { filesystem, retry } = filesystemOptions(options);
    const createMarkerNonce = options.createMarkerNonce ?? (() => crypto.randomBytes(6).toString('hex'));
    const nonce = createMarkerNonce();
    assertPathSegment(nonce, 'Directory transaction marker nonce');
    const temporaryMarker = transactionTempMarkerPath(plan, nonce);
    const stateMarker = transactionStateMarkerPath(plan, state, nonce);
    for (const candidate of [temporaryMarker, stateMarker]) {
        assertProfilePath(plan.parentDirectory, candidate);
    }
    const data = Buffer.from(`${JSON.stringify(transactionMarker(plan, state))}\n`);
    let handle;
    let writeError;
    try {
        handle = await filesystem.open(temporaryMarker, 'wx');
        await handle.writeFile(data);
        await handle.sync();
    } catch (error) {
        writeError = error;
    }
    let closeError;
    try {
        await handle?.close();
    } catch (error) {
        closeError = error;
    }
    if (writeError && closeError) {
        throw new AggregateError([writeError, closeError], 'Transaction marker write and close both failed.');
    }
    if (writeError) {
        throw writeError;
    }
    if (closeError) {
        throw closeError;
    }
    await retryRename(filesystem, temporaryMarker, stateMarker, retry);
    await syncParentDirectory(plan.parentDirectory, filesystem, options.platform ?? process.platform);
    return stateMarker;
}

async function removeTransactionMarkerFiles(plan, filesystem, retry) {
    const markerPrefix = path.basename(plan.markerPrefix);
    const legacyMarker = path.basename(plan.markerPath);
    const entries = await filesystem.readdir(plan.parentDirectory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
        if (entry.name !== legacyMarker && !entry.name.startsWith(markerPrefix)) {
            continue;
        }
        if (!entry.isFile() || entry.isSymbolicLink()) {
            throw new Error(`Directory transaction marker is not a regular file: ${entry.name}`);
        }
        await retryUnlink(filesystem, path.join(plan.parentDirectory, entry.name), retry);
    }
}

function parseTransactionMarker(text, plan, expected = undefined) {
    let marker;
    try {
        marker = JSON.parse(text);
    } catch (error) {
        throw new Error(`Malformed directory transaction marker ${plan.markerPath}: ${error.message}`);
    }
    const legacy = marker?.schema === 'ride.directory-transaction@1';
    const exactKeys = legacy
        ? ['schema', 'state', 'targetName', 'transactionId']
        : ['schema', 'sequence', 'state', 'targetName', 'transactionId'];
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)
        || Object.keys(marker).sort(compareText).join('\0') !== exactKeys.join('\0')
        || (!legacy && marker.schema !== 'ride.directory-transaction@2')
        || marker.targetName !== plan.targetName
        || marker.transactionId !== plan.transactionId
        || !transactionStates.has(marker.state)
        || (!legacy && marker.sequence !== transactionStates.get(marker.state))
        || (expected && (marker.state !== expected.state || marker.sequence !== expected.sequence))) {
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
    const escapedTarget = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = `.${targetName}.transaction-`;
    const statePattern = new RegExp(
        `^\\.${escapedTarget}\\.transaction-(.+)\\.(\\d{2})-(prepared|backed-up|installed|rolled-back)-([A-Za-z0-9][A-Za-z0-9._-]{0,127})\\.json$`,
    );
    const temporaryPattern = new RegExp(
        `^\\.${escapedTarget}\\.transaction-(.+)\\.marker-tmp-([A-Za-z0-9][A-Za-z0-9._-]{0,127})$`,
    );
    const legacyPattern = new RegExp(`^\\.${escapedTarget}\\.transaction-(.+)\\.json$`);
    const groups = new Map();
    const groupFor = transactionId => {
        assertPathSegment(transactionId, 'Directory transaction id');
        if (!groups.has(transactionId)) {
            groups.set(transactionId, { stateFiles: [], temporaryFiles: [], legacyFiles: [] });
        }
        return groups.get(transactionId);
    };
    for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
        if (!entry.name.startsWith(prefix)) {
            continue;
        }
        if (!entry.isFile() || entry.isSymbolicLink()) {
            throw new Error(`Directory transaction marker is not a regular file: ${entry.name}`);
        }
        const stateMatch = entry.name.match(statePattern);
        if (stateMatch) {
            groupFor(stateMatch[1]).stateFiles.push({
                path: path.join(resolvedParent, entry.name),
                sequence: Number(stateMatch[2]),
                state: stateMatch[3],
            });
            continue;
        }
        const temporaryMatch = entry.name.match(temporaryPattern);
        if (temporaryMatch) {
            groupFor(temporaryMatch[1]).temporaryFiles.push(path.join(resolvedParent, entry.name));
            continue;
        }
        const legacyMatch = entry.name.match(legacyPattern);
        if (legacyMatch) {
            groupFor(legacyMatch[1]).legacyFiles.push(path.join(resolvedParent, entry.name));
            continue;
        }
        throw new Error(`Unrecognized directory transaction marker: ${entry.name}`);
    }

    for (const transactionId of [...groups.keys()].sort(compareText)) {
        const group = groups.get(transactionId);
        const plan = createDirectoryTransactionPlan(resolvedParent, targetName, transactionId);
        const complete = [];
        let firstMalformed;
        for (const record of group.stateFiles) {
            try {
                const marker = parseTransactionMarker(
                    await filesystem.readFile(record.path, 'utf8'),
                    plan,
                    record,
                );
                complete.push({ ...record, marker });
            } catch (error) {
                firstMalformed ??= error;
            }
        }
        for (const legacyPath of group.legacyFiles) {
            try {
                const marker = parseTransactionMarker(await filesystem.readFile(legacyPath, 'utf8'), plan);
                complete.push({
                    path: legacyPath,
                    sequence: transactionStates.get(marker.state),
                    state: marker.state,
                    marker,
                });
            } catch (error) {
                firstMalformed ??= error;
            }
        }
        if (complete.length === 0) {
            if (group.stateFiles.length > 0 || group.legacyFiles.length > 0) {
                throw firstMalformed ?? new Error(`Directory transaction ${transactionId} has no complete state marker.`);
            }
            for (const markerPath of group.temporaryFiles) {
                await retryUnlink(filesystem, markerPath, retry);
            }
            continue;
        }
        complete.sort((left, right) => left.sequence - right.sequence || compareText(left.path, right.path));
        for (let index = 1; index < complete.length; index += 1) {
            if (complete[index - 1].sequence === complete[index].sequence) {
                throw new Error(`Directory transaction ${transactionId} has duplicate state markers.`);
            }
        }
        const marker = complete.at(-1).marker;
        let targetExists = await assertRegularDirectoryIfPresent(plan.targetDirectory, filesystem);
        let backupExists = await assertRegularDirectoryIfPresent(plan.backupDirectory, filesystem);
        await assertRegularDirectoryIfPresent(plan.temporaryDirectory, filesystem);
        if (marker.state === 'installed') {
            if (!targetExists) {
                throw new Error(`Cannot safely recover installed directory transaction ${transactionId}.`);
            }
            await retryRemove(filesystem, plan.backupDirectory, retry);
        } else if (marker.state === 'rolled-back') {
            if (!targetExists && backupExists) {
                await retryRename(filesystem, plan.backupDirectory, plan.targetDirectory, retry);
                targetExists = true;
                backupExists = false;
            }
            if (!targetExists || backupExists) {
                throw new Error(`Cannot safely recover rolled-back directory transaction ${transactionId}.`);
            }
        } else if (backupExists) {
            if (targetExists) {
                await retryRemove(filesystem, plan.targetDirectory, retry);
            }
            await retryRename(filesystem, plan.backupDirectory, plan.targetDirectory, retry);
        } else if (marker.state === 'backed-up' && !targetExists) {
            throw new Error(`Cannot safely recover backed-up directory transaction ${transactionId}.`);
        }
        await retryRemove(filesystem, plan.temporaryDirectory, retry);
        const markerPaths = [
            ...group.stateFiles.map(record => record.path),
            ...group.temporaryFiles,
            ...group.legacyFiles,
        ].sort(compareText);
        for (const markerPath of markerPaths) {
            await retryUnlink(filesystem, markerPath, retry);
        }
    }
}

export async function replaceDirectoryTransactional(plan, options = {}) {
    const expected = createDirectoryTransactionPlan(plan.parentDirectory, plan.targetName, plan.transactionId);
    for (const field of ['targetDirectory', 'temporaryDirectory', 'backupDirectory', 'markerPath', 'markerPrefix']) {
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
    await writeTransactionMarker(plan, 'prepared', options);
    if (targetExists) {
        await retryRename(filesystem, plan.targetDirectory, plan.backupDirectory, retry);
        await writeTransactionMarker(plan, 'backed-up', options);
    }
    try {
        await retryRename(filesystem, plan.temporaryDirectory, plan.targetDirectory, retry);
    } catch (installError) {
        if (!targetExists) {
            throw installError;
        }
        try {
            await retryRename(filesystem, plan.backupDirectory, plan.targetDirectory, retry);
            await writeTransactionMarker(plan, 'rolled-back', options);
            await removeTransactionMarkerFiles(plan, filesystem, retry);
        } catch (rollbackError) {
            throw new AggregateError([installError, rollbackError], 'Directory install and rollback both failed.');
        }
        throw installError;
    }
    await writeTransactionMarker(plan, 'installed', options);
    await retryRemove(filesystem, plan.backupDirectory, retry);
    await removeTransactionMarkerFiles(plan, filesystem, retry);
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

function findManifestOnPackageSearchPath(requestName, searchPaths) {
    const segments = requestName.split('/');
    const validSegments = requestName.startsWith('@')
        ? segments.length === 2
        : segments.length === 1;
    if (!validSegments || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) {
        throw new Error(`Invalid installed package request name "${requestName}".`);
    }
    for (const searchPath of searchPaths ?? []) {
        const candidate = path.join(searchPath, ...segments, 'package.json');
        if (fs.existsSync(candidate)) {
            return selectCanonicalPackageManifest(candidate);
        }
    }
    throw new Error(`Unable to locate installed package manifest for "${requestName}".`);
}

export async function resolveInstalledManifest(requestName, fromDirectory) {
    const localRequire = createRequire(path.join(fromDirectory, 'package.json'));
    let manifestPath;
    try {
        manifestPath = localRequire.resolve(`${requestName}/package.json`);
    } catch {
        try {
            const entry = localRequire.resolve(requestName);
            manifestPath = findPackageManifest(entry);
        } catch {
            manifestPath = findManifestOnPackageSearchPath(requestName, localRequire.resolve.paths(requestName));
        }
    }
    manifestPath = selectCanonicalPackageManifest(manifestPath);
    return {
        requestName,
        packageDirectory: path.dirname(manifestPath),
        manifest: JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')),
    };
}

export async function resolveInstalledPackageGraph({
    browserManifest,
    roots,
    resolver,
    browserDirectory,
    canonicalizePackageDirectory = directory => fs.promises.realpath(directory),
}) {
    const records = new Map();
    const dependenciesByNode = new Map();
    const rootNodeIds = new Map();
    const extensionRecords = new Map();
    const load = async (requestName, spec, fromDirectory, dependencyPath, optional = false, rootRequest = false) => {
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
            rootRequest || isTheiaExtension(installed.manifest),
        );
        if (rootRequest) {
            validateInstalledManifest(
                requestName,
                browserManifest.dependencies[requestName],
                installed.manifest,
                dependencyPath,
                'browser manifest',
            );
        }
        const packageDirectory = await canonicalizePackageDirectory(installed.packageDirectory);
        if (typeof packageDirectory !== 'string' || !path.isAbsolute(packageDirectory)) {
            throw new Error(`${dependencyPath.join(' -> ')}: installed dependency has no canonical package directory.`);
        }
        const contextIdentity = canonicalDigest({ dependencyPath });
        const nodeId = canonicalDigest({
            requestName,
            packageName: installed.manifest.name,
            version: installed.manifest.version,
            packageDirectory,
        });
        const existingExtension = extensionRecords.get(requestName);
        if (isTheiaExtension(installed.manifest) && existingExtension
            && (existingExtension.manifest.name !== installed.manifest.name
                || existingExtension.manifest.version !== installed.manifest.version)) {
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
            packageDirectory,
            contextIdentity,
            contextSortKey: dependencyPath.join('\0'),
            manifest: installed.manifest,
            dependencyPath,
        };
        records.set(nodeId, record);
        dependenciesByNode.set(nodeId, new Set());
        if (isTheiaExtension(installed.manifest) && !existingExtension) {
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
        rootNodeIds.set(root, await load(root, spec, browserDirectory, [root], false, true));
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
        const installed = await resolveInstalledManifest(requestName, targetDirectory);
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
    resolveInstalledManifest: installedManifestResolver = resolveInstalledManifest,
    canonicalizePackageDirectory,
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
        resolver: installedManifestResolver,
        browserDirectory: resolvedBrowserDirectory,
        canonicalizePackageDirectory,
    });
    for (const devDependency of profileConfig.buildDevDependencies ?? []) {
        const installed = await installedManifestResolver(devDependency, resolvedBrowserDirectory);
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

async function assertProperPublishLockDirectory(lockDirectory) {
    const state = await pathState(lockDirectory, fs.promises);
    if (!state.exists) {
        return;
    }
    if (!state.stat.isDirectory() || state.stat.isSymbolicLink()) {
        throw new Error(`Refusing non-proper Tauri publish lock path ${lockDirectory}; remove it manually after confirming no publisher is running.`);
    }
    const entries = await fs.promises.readdir(lockDirectory);
    if (entries.length > 0) {
        throw new Error(`Refusing legacy or non-proper Tauri publish lock contents in ${lockDirectory}; remove the lock manually after confirming no legacy publisher is running.`);
    }
}

export async function acquirePublishLock({
    browserDirectory,
    lockProvider = properLockfile,
} = {}) {
    const resolvedBrowserDirectory = path.resolve(browserDirectory);
    if (!lockProvider || typeof lockProvider.lock !== 'function') {
        throw new Error('Tauri publish lock provider must expose lock().');
    }
    const lockDirectory = path.join(resolvedBrowserDirectory, '.ride-tauri-publish.lock');
    assertProfilePath(resolvedBrowserDirectory, lockDirectory);
    await assertProperPublishLockDirectory(lockDirectory);
    let compromisedError;
    const providerRelease = await lockProvider.lock(resolvedBrowserDirectory, {
        realpath: false,
        lockfilePath: lockDirectory,
        stale: PUBLISH_LOCK_STALE_MS,
        update: PUBLISH_LOCK_UPDATE_MS,
        retries: {
            retries: PUBLISH_LOCK_RETRIES,
            factor: 1,
            minTimeout: PUBLISH_LOCK_RETRY_MS,
            maxTimeout: PUBLISH_LOCK_RETRY_MS,
            randomize: false,
        },
        onCompromised: error => {
            compromisedError ??= error;
        },
    });
    if (typeof providerRelease !== 'function') {
        throw new Error('Tauri publish lock provider did not return a release function.');
    }
    const assertHealthy = () => {
        if (compromisedError) {
            throw compromisedError;
        }
    };
    return {
        assertHealthy,
        release: async () => {
            let releaseError;
            try {
                await providerRelease();
            } catch (error) {
                releaseError = error;
            }
            if (releaseError && compromisedError) {
                throw new AggregateError(
                    [compromisedError, releaseError],
                    'Tauri publish lock was compromised and release failed.',
                );
            }
            if (releaseError) {
                throw releaseError;
            }
            assertHealthy();
        },
    };
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
    const lock = await acquirePublishLock({
        ...lockOptions,
        browserDirectory: resolvedBrowserDirectory,
    });
    let result;
    let operationError;
    let publishPlan;
    let transactionStarted = false;
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
        publishPlan = plan;
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
        lock.assertHealthy();
        transactionStarted = true;
        await replaceDirectoryTransactional(plan, transactionOptions);
        lock.assertHealthy();
        await retryRemove(fs.promises, expectedSource, {});
        result = { profile: manifest.profile, buildId: manifest.buildId, digest: manifest.digest, destinationLib };
    } catch (error) {
        if (publishPlan && !transactionStarted) {
            const { filesystem, retry } = filesystemOptions(transactionOptions);
            try {
                await retryRemove(filesystem, publishPlan.temporaryDirectory, retry);
            } catch (cleanupError) {
                operationError = new AggregateError(
                    [error, cleanupError],
                    'Tauri profile copy and temporary cleanup both failed.',
                );
            }
        }
        operationError ??= error;
    }
    let releaseError;
    try {
        await lock.release();
    } catch (error) {
        releaseError = error;
    }
    if (operationError && releaseError) {
        if (operationError === releaseError) {
            throw operationError;
        }
        throw new AggregateError(
            [operationError, releaseError],
            'Tauri profile publish and lock release both failed.',
        );
    }
    if (operationError) {
        throw operationError;
    }
    if (releaseError) {
        throw releaseError;
    }
    return result;
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
