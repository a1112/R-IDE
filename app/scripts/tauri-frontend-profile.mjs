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

function validateInstalledManifest(requestName, spec, manifest, dependencyPath, constraint = 'dependency') {
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
    if (!semver.satisfies(manifest.version, validRange, { includePrerelease: true })) {
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
        if (!entries.has(name)) {
            entries.set(name, {
                spec,
                optional: manifest.peerDependenciesMeta?.[name]?.optional === true,
            });
        }
    }
    return [...entries.entries()].sort(([left], [right]) => compareText(left, right));
}

function isTheiaExtension(manifest) {
    return Array.isArray(manifest?.theiaExtensions);
}

export function resolveProfile({ profileName = 'tauri-critical', profileConfig, browserManifest, packageManifests }) {
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

    const resolveClosure = (closureRoots, label) => {
        if (closureRoots.length === 0) {
            throw new Error(`Tauri frontend profile "${label}" has no roots.`);
        }
        for (const root of closureRoots) {
            if (!Object.hasOwn(browserDependencies, root) || !Object.hasOwn(packageManifests, root)) {
                throw new Error(`Unknown profile root "${root}".`);
            }
        }
        const visited = new Set();
        const dependenciesByNode = new Map();
        const firstPath = new Map();
        const visit = (requestName, parentSpec, ancestry) => {
            const dependencyPath = [...ancestry, requestName];
            const manifest = packageManifests[requestName];
            if (!manifest) {
                throw new Error(`${dependencyPath.join(' -> ')}: required dependency is not installed.`);
            }
            validateInstalledManifest(
                requestName,
                browserDependencies[requestName],
                manifest,
                dependencyPath,
                'browser manifest',
            );
            if (ancestry.length > 0) {
                validateInstalledManifest(requestName, parentSpec, manifest, dependencyPath, 'parent dependency');
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
                if (!Object.hasOwn(browserDependencies, dependencyName)) {
                    continue;
                }
                const installed = packageManifests[dependencyName];
                if (!installed && dependency.optional) {
                    continue;
                }
                if (!installed) {
                    throw new Error(`${[...dependencyPath, dependencyName].join(' -> ')}: required dependency is not installed.`);
                }
                if (!isTheiaExtension(installed)) {
                    continue;
                }
                dependencies.add(dependencyName);
                visit(dependencyName, dependency.spec, dependencyPath);
            }
        };
        for (const root of closureRoots) {
            visit(root, browserDependencies[root], []);
        }
        return { visited, dependenciesByNode, firstPath };
    };

    const criticalClosure = resolveClosure(criticalRoots, 'tauri-critical');
    const selectedClosure = profileName === 'tauri-critical'
        ? criticalClosure
        : resolveClosure(roots, profileName);
    const featureGroups = normalizedFeatureGroups(profileConfig.featureGroups, browserDependencies);
    const resolvedFeatureGroups = {};
    for (const [groupName, group] of Object.entries(featureGroups)) {
        const blockedRoots = group.blockedRoots.map(entry => {
            if (!criticalClosure.visited.has(entry.name)) {
                throw new Error(`Blocked root "${entry.name}" from group "${groupName}" is not in the critical closure.`);
            }
            const dependencyPath = criticalClosure.firstPath.get(entry.name);
            if (!Array.isArray(dependencyPath) || dependencyPath.length === 0 || !criticalRoots.includes(dependencyPath[0])) {
                throw new Error(`Blocked root "${entry.name}" from group "${groupName}" is missing a critical dependency path.`);
            }
            return { ...entry, dependencyPath };
        });
        for (const deferredRoot of group.deferredRoots) {
            if (criticalClosure.visited.has(deferredRoot)) {
                throw new Error(`Deferred root "${deferredRoot}" from group "${groupName}" is required by the critical dependency path ${criticalClosure.firstPath.get(deferredRoot).join(' -> ')}.`);
            }
        }
        resolvedFeatureGroups[groupName] = {
            deferredRoots: group.deferredRoots,
            blockedRoots,
        };
    }

    const closure = stableStronglyConnectedOrder(selectedClosure.visited, selectedClosure.dependenciesByNode);
    const extensions = closure.filter(name => Object.hasOwn(browserDependencies, name));
    const packages = closure.map(requestName => ({
        requestName,
        packageName: packageManifests[requestName].name,
        version: packageManifests[requestName].version,
    }));
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

export function createAtomicDirectoryPlan(browserDirectory, targetName = PROFILE_DIRECTORY_NAME, nonce = `${process.pid}`) {
    if (targetName !== PROFILE_DIRECTORY_NAME) {
        throw new Error(`Atomic profile target must be named ${PROFILE_DIRECTORY_NAME}.`);
    }
    const resolvedBrowserDirectory = path.resolve(browserDirectory);
    const targetDirectory = path.join(resolvedBrowserDirectory, targetName);
    const unique = crypto.randomBytes(6).toString('hex');
    const temporaryDirectory = path.join(resolvedBrowserDirectory, `${targetName}.tmp-${nonce}-${unique}`);
    const backupDirectory = path.join(resolvedBrowserDirectory, `${targetName}.old-${nonce}-${unique}`);
    assertProfilePath(resolvedBrowserDirectory, targetDirectory);
    assertProfilePath(resolvedBrowserDirectory, temporaryDirectory);
    assertProfilePath(resolvedBrowserDirectory, backupDirectory);
    return { targetDirectory, temporaryDirectory, backupDirectory };
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

async function replaceDirectoryAtomically(plan) {
    const targetExists = await fs.promises.lstat(plan.targetDirectory).then(() => true, error => {
        if (error.code === 'ENOENT') {
            return false;
        }
        throw error;
    });
    if (targetExists) {
        await fs.promises.rename(plan.targetDirectory, plan.backupDirectory);
    }
    try {
        await fs.promises.rename(plan.temporaryDirectory, plan.targetDirectory);
    } catch (error) {
        if (targetExists) {
            await fs.promises.rename(plan.backupDirectory, plan.targetDirectory);
        }
        throw error;
    }
    if (targetExists) {
        await fs.promises.rm(plan.backupDirectory, { recursive: true, force: true });
    }
}

function findPackageManifest(packageEntry) {
    let directory = path.dirname(packageEntry);
    while (true) {
        const candidate = path.join(directory, 'package.json');
        if (fs.existsSync(candidate)) {
            return candidate;
        }
        const parent = path.dirname(directory);
        if (parent === directory) {
            throw new Error(`Unable to locate package manifest for ${packageEntry}.`);
        }
        directory = parent;
    }
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
    return {
        requestName,
        packageDirectory: path.dirname(manifestPath),
        manifest: JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')),
    };
}

async function loadInstalledClosure(browserManifest, roots, resolver, browserDirectory) {
    const manifests = {};
    const loading = new Set();
    const load = async (requestName, fromDirectory, optional = false) => {
        if (loading.has(requestName) || Object.hasOwn(manifests, requestName)) {
            return;
        }
        loading.add(requestName);
        let installed;
        try {
            installed = await resolver(requestName, fromDirectory);
        } catch (error) {
            loading.delete(requestName);
            if (optional) {
                return;
            }
            throw new Error(`Required dependency "${requestName}" is not installed: ${error.message}`);
        }
        manifests[requestName] = installed.manifest;
        for (const [dependencyName, dependency] of dependencyEntries(installed.manifest)) {
            if (!Object.hasOwn(browserManifest.dependencies ?? {}, dependencyName)) {
                continue;
            }
            // Every node in this graph is a direct browser application root.
            // Resolve from that application, not from a dependency's nested
            // node_modules, so another workspace application's version cannot
            // shadow the version declared by the browser manifest.
            await load(dependencyName, browserDirectory, dependency.optional);
        }
        loading.delete(requestName);
    };
    for (const root of roots) {
        await load(root, browserDirectory);
    }
    return { manifests };
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

export async function generateProfileTarget({
    browserDirectory,
    profileName = 'tauri-critical',
    resolveInstalledManifest = defaultResolveInstalledManifest,
} = {}) {
    const resolvedBrowserDirectory = path.resolve(browserDirectory);
    const browserManifest = JSON.parse(await fs.promises.readFile(path.join(resolvedBrowserDirectory, 'package.json'), 'utf8'));
    const profileConfig = JSON.parse(await fs.promises.readFile(path.join(resolvedBrowserDirectory, 'tauri-profile.json'), 'utf8'));
    const roots = selectedRoots(profileName, profileConfig, browserManifest);
    const { manifests } = await loadInstalledClosure(browserManifest, roots, resolveInstalledManifest, resolvedBrowserDirectory);
    for (const devDependency of profileConfig.buildDevDependencies ?? []) {
        const installed = await resolveInstalledManifest(devDependency, resolvedBrowserDirectory);
        validateInstalledManifest(devDependency, browserManifest.devDependencies?.[devDependency], installed.manifest, [devDependency]);
    }
    const resolved = resolveProfile({ profileName, profileConfig, browserManifest, packageManifests: manifests });
    const plan = createAtomicDirectoryPlan(resolvedBrowserDirectory);
    await fs.promises.rm(plan.temporaryDirectory, { recursive: true, force: true });
    await fs.promises.mkdir(plan.temporaryDirectory, { recursive: true });
    try {
        const dependencies = Object.fromEntries(resolved.extensions.map(name => [name, browserManifest.dependencies[name]]));
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
            commit: currentCommit(),
            profile: resolved.profile,
            digest: resolved.digest,
            roots: resolved.roots,
            extensions: resolved.extensions,
            packages: resolved.packages,
            featureGroups: resolved.featureGroups,
        };
        await fs.promises.writeFile(path.join(plan.temporaryDirectory, PROFILE_MANIFEST_NAME), `${JSON.stringify(profileManifest, null, 2)}\n`);
        await replaceDirectoryAtomically(plan);
    } catch (error) {
        await fs.promises.rm(plan.temporaryDirectory, { recursive: true, force: true });
        throw error;
    }
    return { ...resolved, targetDirectory: plan.targetDirectory };
}

export async function publishProfileBuild({ browserDirectory } = {}) {
    const resolvedBrowserDirectory = path.resolve(browserDirectory);
    const profileDirectory = path.join(resolvedBrowserDirectory, PROFILE_DIRECTORY_NAME);
    const sourceLib = path.join(profileDirectory, 'lib');
    const sourceManifest = path.join(profileDirectory, PROFILE_MANIFEST_NAME);
    const destinationLib = path.join(resolvedBrowserDirectory, 'lib');
    const unique = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const temporaryLib = path.join(resolvedBrowserDirectory, `.ride-tauri-lib.tmp-${unique}`);
    const backupLib = path.join(resolvedBrowserDirectory, `.ride-tauri-lib.old-${unique}`);
    assertProfilePath(resolvedBrowserDirectory, temporaryLib);
    assertProfilePath(resolvedBrowserDirectory, backupLib);
    await fs.promises.rm(temporaryLib, { recursive: true, force: true });
    await copyRegularTree(sourceLib, temporaryLib);
    const manifestText = await fs.promises.readFile(sourceManifest);
    await fs.promises.writeFile(path.join(temporaryLib, PROFILE_MANIFEST_NAME), manifestText);
    for (const output of ['frontend', 'backend']) {
        await fs.promises.mkdir(path.join(temporaryLib, output), { recursive: true });
        await fs.promises.writeFile(path.join(temporaryLib, output, PROFILE_MANIFEST_NAME), manifestText);
    }
    const destinationExists = fs.existsSync(destinationLib);
    if (destinationExists) {
        await fs.promises.rename(destinationLib, backupLib);
    }
    try {
        await fs.promises.rename(temporaryLib, destinationLib);
    } catch (error) {
        if (destinationExists) {
            await fs.promises.rename(backupLib, destinationLib);
        }
        throw error;
    }
    if (destinationExists) {
        await fs.promises.rm(backupLib, { recursive: true, force: true });
    }
}

async function runCli() {
    const command = process.argv[2];
    const profileIndex = process.argv.indexOf('--profile');
    const profileName = profileIndex >= 0 ? process.argv[profileIndex + 1] : process.env.RIDE_TAURI_FRONTEND_PROFILE ?? 'tauri-critical';
    const browserDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'applications', 'browser');
    if (command === 'prepare') {
        const result = await generateProfileTarget({ browserDirectory, profileName });
        process.stdout.write(`Prepared ${result.profile} profile ${result.digest} at ${result.targetDirectory}\n`);
        return;
    }
    if (command === 'publish') {
        await publishProfileBuild({ browserDirectory });
        process.stdout.write(`Published ${profileName} frontend and backend bundles.\n`);
        return;
    }
    throw new Error('Usage: node tauri-frontend-profile.mjs <prepare|publish> [--profile <name>]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runCli().catch(error => {
        console.error(`Tauri frontend profile failed: ${error.message}`);
        process.exitCode = 1;
    });
}
