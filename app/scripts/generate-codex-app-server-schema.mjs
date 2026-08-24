import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '..');
const reviewedVersion = '0.144.0';
const generatedRoot = join(appRoot, 'theia-extensions', 'codex', 'src', 'common', 'generated', 'app-server', reviewedVersion);
const compatibilityPath = join(appRoot, 'theia-extensions', 'codex', 'src', 'common', 'codex-app-server-compatibility.json');
const schemaSourceName = 'codex_app_server_protocol.schemas.json';
const maxOutput = 32 * 1024;

function fail(message) {
    throw new Error(`Codex App Server schema: ${message}`);
}

function parseArgs(args) {
    const parsed = { mode: undefined, version: undefined, codex: undefined };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--write' || arg === '--check') {
            if (parsed.mode) fail('choose exactly one of --write or --check');
            parsed.mode = arg.slice(2);
        } else if (arg === '--version' || arg === '--codex') {
            if (parsed[arg.slice(2)]) fail(`${arg} may only be supplied once`);
            const value = args[++index];
            if (!value || value.startsWith('--')) fail(`${arg} requires a value`);
            parsed[arg.slice(2)] = value;
        } else {
            fail(`unknown or prohibited argument: ${arg}`);
        }
    }
    if (!parsed.mode) fail('a mode is required: --write or --check');
    if (!parsed.version) fail('--version is required');
    if (parsed.version !== reviewedVersion) fail(`reviewed version is ${reviewedVersion}, received ${parsed.version}`);
    return parsed;
}

function bounded(value) {
    return String(value ?? '').slice(0, maxOutput);
}

function run(executable, args) {
    const command = extname(executable).toLowerCase() === '.cmd'
        ? ['cmd.exe', ['/d', '/s', '/c', `""${executable.replace(/(["^&|<>()])/g, '^$1').replace(/%/g, '%%')}" ${args.map(arg => `"${arg.replace(/(["^&|<>()])/g, '^$1').replace(/%/g, '%%')}"`).join(' ')}"`]]
        : [executable, args];
    const result = spawnSync(command[0], command[1], { encoding: 'utf8', shell: false, windowsHide: true, windowsVerbatimArguments: extname(executable).toLowerCase() === '.cmd', maxBuffer: maxOutput });
    if (result.error) fail(`could not run ${basename(executable)}: ${result.error.message}`);
    if (result.status !== 0) fail(`${basename(executable)} ${args[0]} failed: ${bounded(result.stderr) || bounded(result.stdout)}`);
    return bounded(result.stdout);
}

function resolveCodex(command) {
    if (process.platform !== 'win32' || isAbsolute(command) || command.includes('/') || command.includes('\\')) return [command];
    const found = spawnSync('where.exe', [command], { encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: maxOutput });
    const candidates = bounded(found.stdout).split(/\r?\n/).filter(Boolean);
    return [...candidates.filter(candidate => extname(candidate).toLowerCase() === '.exe'), ...candidates.filter(candidate => extname(candidate).toLowerCase() !== '.exe'), command];
}

function verifyCodex(command, version) {
    const failures = [];
    for (const executable of resolveCodex(command)) {
        try {
            const output = run(executable, ['--version']).trim();
            if (output === `codex-cli ${version}`) return executable;
            failures.push(`${basename(executable)} reported ${output || 'no version output'}`);
        } catch (error) {
            failures.push(error.message);
        }
    }
    fail(`expected codex-cli ${version}; ${failures.join('; ')}`);
}

function walk(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
    }).sort((left, right) => left.localeCompare(right));
}

function normalizeText(text) {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n*$/, '\n');
}

function normalizeGenerated(source, destination) {
    const sourceTypes = join(source, 'types');
    const sourceSchema = join(source, 'schema', schemaSourceName);
    if (!existsSync(sourceTypes) || !existsSync(sourceSchema)) fail('generator output is partial or malformed');
    const typeFiles = walk(sourceTypes);
    if (typeFiles.length === 0 || typeFiles.some(file => extname(file) !== '.ts')) fail('generated TypeScript output is malformed');
    mkdirSync(join(destination, 'types'), { recursive: true });
    for (const file of typeFiles) {
        const target = join(destination, 'types', relative(sourceTypes, file));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, normalizeText(readFileSync(file, 'utf8')), 'utf8');
    }
    writeFileSync(join(destination, 'schema.json'), normalizeText(readFileSync(sourceSchema, 'utf8')), 'utf8');
}

function sha256(file) {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function fixtureMetadata(root) {
    const schema = join(root, 'schema.json');
    const types = join(root, 'types');
    if (!existsSync(schema) || !existsSync(types)) fail('reviewed fixture layout is incomplete');
    const typeFiles = walk(types).map(file => ({ path: relative(types, file).replaceAll('\\', '/'), sha256: sha256(file) }));
    if (!typeFiles.length || typeFiles.some(file => !file.path.endsWith('.ts'))) fail('reviewed TypeScript fixture is malformed');
    return {
        schemaSha256: sha256(schema),
        typeFileCount: typeFiles.length,
        typesSha256: createHash('sha256').update(typeFiles.map(file => `${file.path}:${file.sha256}\n`).join('')).digest('hex')
    };
}

function validateMetadata(root) {
    if (!existsSync(compatibilityPath)) fail('compatibility metadata is missing');
    const compatibility = JSON.parse(readFileSync(compatibilityPath, 'utf8'));
    const metadata = fixtureMetadata(root);
    if (compatibility.codexCliVersion !== reviewedVersion || compatibility.schemaDirectory !== `generated/app-server/${reviewedVersion}`) fail('compatibility metadata does not pin the reviewed fixture');
    if (compatibility.schemaSha256 !== metadata.schemaSha256) fail('schema fixture hash drifted from compatibility metadata');
    if (compatibility.typeFileCount !== metadata.typeFileCount || compatibility.typesSha256 !== metadata.typesSha256) fail('generated TypeScript fixture drifted from compatibility metadata');
}

function validateFixture() {
    validateMetadata(generatedRoot);
}

function generate(executable) {
    const temporary = mkdtempSync(join(tmpdir(), 'ride-codex-app-server-'));
    try {
        run(executable, ['app-server', 'generate-ts', '--out', join(temporary, 'types')]);
        run(executable, ['app-server', 'generate-json-schema', '--out', join(temporary, 'schema')]);
        const normalized = join(temporary, 'normalized');
        normalizeGenerated(temporary, normalized);
        return { temporary, normalized };
    } catch (error) {
        rmSync(temporary, { recursive: true, force: true });
        throw error;
    }
}

function sameTree(left, right) {
    const leftFiles = walk(left).map(file => relative(left, file).replaceAll('\\', '/'));
    const rightFiles = walk(right).map(file => relative(right, file).replaceAll('\\', '/'));
    return JSON.stringify(leftFiles) === JSON.stringify(rightFiles) && leftFiles.every(file => readFileSync(join(left, file)).equals(readFileSync(join(right, file))));
}

function publish(source) {
    const staged = `${generatedRoot}.staged-${process.pid}`;
    const backup = `${generatedRoot}.backup-${process.pid}`;
    rmSync(staged, { recursive: true, force: true });
    cpSync(source, staged, { recursive: true });
    try {
        if (existsSync(generatedRoot)) renameSync(generatedRoot, backup);
        renameSync(staged, generatedRoot);
        rmSync(backup, { recursive: true, force: true });
    } catch (error) {
        rmSync(staged, { recursive: true, force: true });
        if (!existsSync(generatedRoot) && existsSync(backup)) renameSync(backup, generatedRoot);
        throw error;
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.codex) {
        validateFixture();
        return;
    }
    const executable = verifyCodex(args.codex, args.version);
    const generated = generate(executable);
    try {
        if (args.mode === 'write') {
            validateMetadata(generated.normalized);
            publish(generated.normalized);
            validateFixture();
        } else {
            validateFixture();
            if (!sameTree(generated.normalized, generatedRoot)) fail('checked-in fixture differs from regenerated stable output');
        }
    } finally {
        rmSync(generated.temporary, { recursive: true, force: true });
    }
}

try {
    main();
} catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
}
