/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
    RideCodexLaunchSpec,
    RideCodexRuntimeSource
} from '../src/node/ride-codex-launch-spec';
import {
    RideCodexBoundedExecRunner,
    RideCodexProbeCommandError,
    RideCodexRuntimeProbe,
    RideCodexRuntimeProbeLike,
    RideCodexSpawn
} from '../src/node/ride-codex-runtime-probe';
import {
    discoverDefaultCodexSystemCandidates,
    RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS,
    RideCodexRuntimeFileStat,
    RideCodexRuntimeFileSystem,
    RideCodexRuntimeConfigurationError,
    RideCodexRuntimeResolver,
    RideCodexRuntimeUnavailableError,
    targetForPlatform
} from '../src/node/ride-codex-runtime-resolver';

const WINDOWS_TARGET = 'x86_64-pc-windows-msvc';
const WINDOWS_NATIVE = 'C:\\tools\\codex.exe';

interface VirtualFile {
    readonly kind: 'file' | 'directory' | 'symlink';
    readonly content?: string | Uint8Array;
    readonly executable?: boolean;
    readonly realPath?: string;
}

type ManifestOverrides = Partial<{
    layoutVersion: unknown;
    version: unknown;
    target: unknown;
    variant: unknown;
    entrypoint: unknown;
}>;

interface ProbeLimits {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
}

class VirtualFileSystem implements RideCodexRuntimeFileSystem {
    readonly calls: string[] = [];
    private readonly files = new Map<string, VirtualFile>();

    addFile(path: string, content: string | Uint8Array = '', executable = true): void {
        this.files.set(this.key(path), { kind: 'file', content, executable });
    }

    addDirectory(path: string): void {
        this.files.set(this.key(path), { kind: 'directory' });
    }

    addSymlink(path: string, realPath: string): void {
        this.files.set(this.key(path), { kind: 'symlink', realPath });
    }

    async lstat(path: string): Promise<RideCodexRuntimeFileStat> {
        this.calls.push(`lstat:${path}`);
        const file = this.files.get(this.key(path));
        if (!file) {
            const error = new Error('missing') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
        }
        return {
            size: typeof file.content === 'string'
                ? Buffer.byteLength(file.content)
                : file.content?.byteLength ?? 0,
            isFile: () => file.kind === 'file',
            isSymbolicLink: () => file.kind === 'symlink'
        };
    }

    async readTextFile(path: string): Promise<string> {
        this.calls.push(`read:${path}`);
        const file = this.files.get(this.key(path));
        if (!file || file.kind !== 'file') {
            throw new Error('not a file');
        }
        return typeof file.content === 'string'
            ? file.content
            : Buffer.from(file.content ?? []).toString('utf8');
    }

    async readFilePrefix(path: string, maxBytes: number): Promise<Uint8Array> {
        this.calls.push(`prefix:${path}:${maxBytes}`);
        const file = this.files.get(this.key(path));
        if (!file || file.kind !== 'file') {
            throw new Error('not a file');
        }
        const content = typeof file.content === 'string'
            ? Buffer.from(file.content)
            : Buffer.from(file.content ?? []);
        return content.subarray(0, maxBytes);
    }

    async realpath(path: string): Promise<string> {
        this.calls.push(`realpath:${path}`);
        const file = this.files.get(this.key(path));
        if (!file) {
            const error = new Error('missing') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
        }
        return file.realPath ?? path;
    }

    async isExecutable(path: string): Promise<boolean> {
        this.calls.push(`executable:${path}`);
        const file = this.files.get(this.key(path));
        return file?.kind === 'file' && file.executable !== false;
    }

    private key(path: string): string {
        return path.replace(/\//g, '\\').toLowerCase();
    }
}

class FakeProbe implements RideCodexRuntimeProbeLike {
    readonly calls: Array<{ executable: string; target: string }> = [];
    private readonly failures = new Map<string, Error>();
    private readonly versions = new Map<string, string>();
    delay: Promise<void> | undefined;

    fail(path: string, message: string): void {
        this.failures.set(this.key(path), new Error(message));
    }

    version(path: string, version: string): void {
        this.versions.set(this.key(path), version);
    }

    async probe(executable: string, target: string): Promise<{ readonly version: string; readonly target: string }> {
        this.calls.push({ executable, target });
        await this.delay;
        const failure = this.failures.get(this.key(executable));
        if (failure) {
            throw failure;
        }
        return { version: this.versions.get(this.key(executable)) ?? '0.144.0', target };
    }

    private key(path: string): string {
        return path.replace(/\//g, '\\').toLowerCase();
    }
}

interface ResolverFixture {
    readonly fs: VirtualFileSystem;
    readonly probe: FakeProbe;
    readonly counters: Record<string, number>;
    readonly resolver: RideCodexRuntimeResolver;
}

function createResolver(options: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly userOverride?: string;
    readonly system?: readonly string[];
    readonly managed?: string;
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
    readonly fs?: VirtualFileSystem;
    readonly probe?: FakeProbe;
} = {}): ResolverFixture {
    const fs = options.fs ?? new VirtualFileSystem();
    const probe = options.probe ?? new FakeProbe();
    const counters = { environment: 0, user: 0, system: 0, managed: 0 };
    const resolver = new RideCodexRuntimeResolver({
        platform: options.platform ?? 'win32',
        arch: options.arch ?? 'x64',
        filesystem: fs,
        probe,
        readEnvironment: () => {
            counters.environment += 1;
            return options.environment ?? {};
        },
        readUserOverride: async () => {
            counters.user += 1;
            return options.userOverride;
        },
        findSystemCandidates: async () => {
            counters.system += 1;
            return options.system ?? [];
        },
        readManagedActiveRuntime: async () => {
            counters.managed += 1;
            return options.managed;
        }
    });
    return { fs, probe, counters, resolver };
}

function assertLaunchSpec(
    spec: RideCodexLaunchSpec,
    expected: { executable: string; source: RideCodexRuntimeSource; target?: string }
): void {
    assert.equal(spec.executable, expected.executable);
    assert.equal(spec.version, '0.144.0');
    assert.equal(spec.target, expected.target ?? WINDOWS_TARGET);
    assert.equal(spec.source, expected.source);
    assert.deepEqual(spec.environment, {});
    assert.ok(Object.isFrozen(spec));
    assert.ok(Object.isFrozen(spec.environment));
    assert.ok(Object.isFrozen(spec.diagnostics));
    assert.ok(spec.diagnostics.length <= 8);
    assert.ok(spec.diagnostics.every((diagnostic: string) => diagnostic.length <= 160));
    assert.equal(Object.keys(spec.environment).some(key => /api.?key|token|secret/i.test(key)), false);
}

function wrapperBody(extension: 'cmd' | 'ps1'): string {
    return extension === 'cmd'
        ? '"%dp0%\\node.exe" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
        : '& "$basedir/node.exe" "$basedir/node_modules/@openai/codex/bin/codex.js" $args';
}

function addWindowsNpmLayout(
    fs: VirtualFileSystem,
    wrapper: string,
    options: {
        readonly nested?: boolean;
        readonly manifest?: ManifestOverrides;
        readonly executableKind?: 'file' | 'directory' | 'symlink';
        readonly executableRealPath?: string;
        readonly wrapperBody?: string;
    } = {}
): { manifest: string; executable: string } {
    const extension = wrapper.toLowerCase().endsWith('.ps1') ? 'ps1' : 'cmd';
    fs.addFile(wrapper, options.wrapperBody ?? wrapperBody(extension));
    const packageBase = options.nested
        ? 'C:\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64'
        : 'C:\\npm\\node_modules\\@openai\\codex-win32-x64';
    const vendor = `${packageBase}\\vendor\\${WINDOWS_TARGET}`;
    const manifest = `${vendor}\\codex-package.json`;
    const manifestValue = {
        layoutVersion: 1,
        version: '0.144.0',
        target: WINDOWS_TARGET,
        variant: 'codex',
        entrypoint: 'bin/codex.exe',
        ...options.manifest
    };
    fs.addFile(manifest, JSON.stringify(manifestValue));
    const entrypoint = typeof manifestValue.entrypoint === 'string' ? manifestValue.entrypoint : 'bin/codex.exe';
    const executable = entrypoint.startsWith('C:')
        ? entrypoint
        : `${vendor}\\${entrypoint.replace(/\//g, '\\')}`;
    if (options.executableKind === 'directory') {
        fs.addDirectory(executable);
    } else if (options.executableKind === 'symlink') {
        fs.addSymlink(executable, options.executableRealPath ?? 'C:\\escape\\codex.exe');
    } else {
        fs.addFile(executable);
    }
    return { manifest, executable };
}

test('constructor is inert and concurrent resolve performs one lazy stable resolution', async () => {
    let releaseProbe: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
        releaseProbe = resolve;
    });
    const probe = new FakeProbe();
    probe.delay = gate;
    const fixture = createResolver({ environment: { RIDE_CODEX_PATH: WINDOWS_NATIVE }, probe });
    fixture.fs.addFile(WINDOWS_NATIVE);

    assert.deepEqual(fixture.counters, { environment: 0, user: 0, system: 0, managed: 0 });
    assert.deepEqual(fixture.fs.calls, []);
    assert.deepEqual(probe.calls, []);

    const first = fixture.resolver.resolve();
    const second = fixture.resolver.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.counters.environment, 1);
    assert.equal(fixture.counters.user, 0);
    assert.equal(fixture.counters.system, 0);
    assert.equal(fixture.counters.managed, 0);
    assert.equal(probe.calls.length, 1);

    releaseProbe?.();
    const [firstSpec, secondSpec, laterSpec] = await Promise.all([first, second, fixture.resolver.resolve()]);
    assert.strictEqual(firstSpec, secondSpec);
    assert.strictEqual(firstSpec, laterSpec);
    assertLaunchSpec(firstSpec, { executable: WINDOWS_NATIVE, source: 'override' });
});

test('environment and user overrides are exclusive and take priority over system and managed runtimes', async t => {
    await t.test('RIDE_CODEX_PATH is first and avoids all lower-priority providers', async () => {
        const fixture = createResolver({
            environment: { RIDE_CODEX_PATH: WINDOWS_NATIVE },
            userOverride: 'C:\\user\\codex.exe',
            system: ['C:\\system\\codex.exe'],
            managed: 'C:\\managed\\codex.exe'
        });
        fixture.fs.addFile(WINDOWS_NATIVE);
        const spec = await fixture.resolver.resolve();
        assertLaunchSpec(spec, { executable: WINDOWS_NATIVE, source: 'override' });
        assert.deepEqual(fixture.counters, { environment: 1, user: 0, system: 0, managed: 0 });
        assert.deepEqual(fixture.probe.calls.map(call => call.executable), [WINDOWS_NATIVE]);
    });

    await t.test('user override is used when RIDE_CODEX_PATH is absent', async () => {
        const user = 'C:\\user\\codex.exe';
        const fixture = createResolver({
            userOverride: user,
            system: ['C:\\system\\codex.exe'],
            managed: 'C:\\managed\\codex.exe'
        });
        fixture.fs.addFile(user);
        const spec = await fixture.resolver.resolve();
        assertLaunchSpec(spec, { executable: user, source: 'override' });
        assert.deepEqual(fixture.counters, { environment: 1, user: 1, system: 0, managed: 0 });
        assert.deepEqual(fixture.probe.calls.map(call => call.executable), [user]);
    });
});

test('explicit blank overrides fail without consulting lower-priority runtime providers', async t => {
    for (const blank of ['', ' ', '\t']) {
        await t.test(`RIDE_CODEX_PATH ${JSON.stringify(blank)}`, async () => {
            const fixture = createResolver({
                environment: { RIDE_CODEX_PATH: blank },
                userOverride: WINDOWS_NATIVE,
                system: [WINDOWS_NATIVE],
                managed: WINDOWS_NATIVE
            });
            fixture.fs.addFile(WINDOWS_NATIVE);

            await assert.rejects(
                fixture.resolver.resolve(),
                error => error instanceof RideCodexRuntimeConfigurationError && /empty|blank|path/i.test(error.message)
            );
            assert.deepEqual(fixture.counters, { environment: 1, user: 0, system: 0, managed: 0 });
            assert.deepEqual(fixture.fs.calls, []);
            assert.deepEqual(fixture.probe.calls, []);
        });

        await t.test(`user override ${JSON.stringify(blank)}`, async () => {
            const fixture = createResolver({
                userOverride: blank,
                system: [WINDOWS_NATIVE],
                managed: WINDOWS_NATIVE
            });
            fixture.fs.addFile(WINDOWS_NATIVE);

            await assert.rejects(
                fixture.resolver.resolve(),
                error => error instanceof RideCodexRuntimeConfigurationError && /empty|blank|path/i.test(error.message)
            );
            assert.deepEqual(fixture.counters, { environment: 1, user: 1, system: 0, managed: 0 });
            assert.deepEqual(fixture.fs.calls, []);
            assert.deepEqual(fixture.probe.calls, []);
        });
    }
});

test('system candidates precede managed runtime and incompatible implicit candidates fall through', async () => {
    const missing = 'C:\\missing\\codex.exe';
    const incompatible = 'C:\\old\\codex.exe';
    const managed = 'C:\\managed\\codex.exe';
    const fixture = createResolver({ system: [missing, incompatible], managed });
    fixture.fs.addFile(incompatible);
    fixture.fs.addFile(managed);
    fixture.probe.fail(incompatible, 'incompatible CLI version');

    const spec = await fixture.resolver.resolve();

    assertLaunchSpec(spec, { executable: managed, source: 'managed' });
    assert.deepEqual(fixture.counters, { environment: 1, user: 1, system: 1, managed: 1 });
    assert.deepEqual(fixture.probe.calls.map(call => call.executable), [incompatible, managed]);
    assert.ok(spec.diagnostics.length >= 2);
    assert.ok(spec.diagnostics.every((diagnostic: string) => !diagnostic.includes(missing)));
});

test('a valid system runtime prevents reading the managed active pointer', async () => {
    const system = 'C:\\system\\codex.exe';
    const fixture = createResolver({ system: [system], managed: 'C:\\managed\\codex.exe' });
    fixture.fs.addFile(system);

    const spec = await fixture.resolver.resolve();

    assertLaunchSpec(spec, { executable: system, source: 'system' });
    assert.equal(fixture.counters.managed, 0);
    assert.deepEqual(fixture.probe.calls.map(call => call.executable), [system]);
});

test('finds a system runtime after a realistically long PATH candidate list', async () => {
    const system = 'C:\\late-system\\codex.exe';
    const preceding = Array.from({ length: 96 }, (_, index) => `C:\\missing-${index}\\codex.exe`);
    const fixture = createResolver({ system: [...preceding, system] });
    fixture.fs.addFile(system);

    const spec = await fixture.resolver.resolve();

    assertLaunchSpec(spec, { executable: system, source: 'system' });
    assert.deepEqual(fixture.probe.calls.map(call => call.executable), [system]);
});

test('default PATH discovery bounds tokenization, candidate generation, and filesystem checks', async t => {
    const windowsDirectories = Array.from({ length: 2_000 }, (_, index) => `C:\\path-${index}`);
    const windows = discoverDefaultCodexSystemCandidates(
        { PATH: windowsDirectories.join(';') },
        'win32'
    );

    assert.equal(windows.candidates.length, RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS.maxCandidates);
    assert.ok(windows.scannedDirectories <= RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS.maxDirectories);
    assert.ok(windows.scannedPathBytes <= RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS.maxPathBytes);
    assert.equal(windows.truncated, true);
    assert.deepEqual(windows.candidates.slice(0, 3), [
        'C:\\path-0\\codex.exe',
        'C:\\path-0\\codex.cmd',
        'C:\\path-0\\codex.ps1'
    ]);
    assert.ok(windows.diagnostics.length > 0);
    assert.ok(windows.diagnostics.every((diagnostic: string) => diagnostic.length <= 160));

    const posixDirectories = Array.from({ length: 2_000 }, (_, index) => `/opt/path-${index}`);
    const posixDiscovery = discoverDefaultCodexSystemCandidates(
        { PATH: posixDirectories.join(':') },
        'linux'
    );
    assert.equal(posixDiscovery.candidates.length, RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS.maxCandidates);
    assert.equal(posixDiscovery.scannedDirectories, RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS.maxDirectories);
    assert.deepEqual(posixDiscovery.candidates.slice(0, 2), [
        '/opt/path-0/codex',
        '/opt/path-1/codex'
    ]);
    assert.equal(posixDiscovery.truncated, true);

    const longDirectories = Array.from(
        { length: 128 },
        (_, index) => `/opt/${'a'.repeat(1_024)}-${index}`
    );
    const byteBounded = discoverDefaultCodexSystemCandidates(
        { PATH: longDirectories.join(':') },
        'linux'
    );
    assert.equal(byteBounded.truncated, true);
    assert.ok(byteBounded.scannedPathBytes <= RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS.maxPathBytes);
    assert.ok(byteBounded.scannedDirectories < RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS.maxDirectories);
    assert.ok(byteBounded.candidates.length < RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS.maxCandidates);

    await t.test('resolver checks only the generated bound and reports truncation', async () => {
        const fs = new VirtualFileSystem();
        let managedCalls = 0;
        const resolver = new RideCodexRuntimeResolver({
            platform: 'win32',
            arch: 'x64',
            filesystem: fs,
            probe: new FakeProbe(),
            readEnvironment: () => ({ PATH: windowsDirectories.join(';') }),
            readUserOverride: () => undefined,
            readManagedActiveRuntime: () => {
                managedCalls += 1;
                return undefined;
            }
        });

        await assert.rejects(resolver.resolve(), error => {
            assert.ok(error instanceof RideCodexRuntimeUnavailableError);
            const runtimeError = error as RideCodexRuntimeUnavailableError;
            assert.ok(runtimeError.diagnostics.some(diagnostic => /truncat|limit/i.test(diagnostic)));
            assert.ok(runtimeError.diagnostics.every(diagnostic => diagnostic.length <= 160));
            return true;
        });
        assert.equal(
            fs.calls.filter(call => call.startsWith('lstat:')).length,
            RIDE_CODEX_RUNTIME_DISCOVERY_LIMITS.maxCandidates
        );
        assert.equal(managedCalls, 1);
    });
});

test('invalid explicit overrides fail actionably without fallback or secret disclosure', async t => {
    const cases: ReadonlyArray<{
        readonly name: string;
        readonly configure: (fixture: ResolverFixture, path: string) => void;
        readonly expected: RegExp;
    }> = [
        { name: 'missing', configure: () => undefined, expected: /does not exist|missing/i },
        { name: 'not a file', configure: fixture => fixture.fs.addDirectory(WINDOWS_NATIVE), expected: /file/i },
        { name: 'non-native extension', configure: fixture => fixture.fs.addFile('C:\\tools\\codex.js'), expected: /native|executable/i },
        { name: 'unparseable wrapper', configure: fixture => fixture.fs.addFile('C:\\tools\\codex.cmd', '@echo unsafe'), expected: /launcher|wrapper/i },
        {
            name: 'incompatible version',
            configure: fixture => {
                fixture.fs.addFile(WINDOWS_NATIVE);
                fixture.probe.fail(WINDOWS_NATIVE, 'Codex CLI version is incompatible');
            },
            expected: /version|compatible/i
        },
        {
            name: 'missing app-server',
            configure: fixture => {
                fixture.fs.addFile(WINDOWS_NATIVE);
                fixture.probe.fail(WINDOWS_NATIVE, 'Codex App Server command is unavailable');
            },
            expected: /app server|app-server/i
        }
    ];

    for (const entry of cases) {
        await t.test(entry.name, async () => {
            const secret = `C:\\secret-${entry.name}\\${entry.name === 'non-native extension' ? 'codex.js' : entry.name === 'unparseable wrapper' ? 'codex.cmd' : 'codex.exe'}`;
            const fixture = createResolver({
                environment: { RIDE_CODEX_PATH: secret, OPENAI_API_KEY: 'must-not-leak' },
                system: ['C:\\system\\codex.exe'],
                managed: 'C:\\managed\\codex.exe'
            });
            entry.configure(fixture, secret);
            if (entry.name === 'not a file') {
                fixture.fs.addDirectory(secret);
            } else if (entry.name === 'non-native extension') {
                fixture.fs.addFile(secret);
            } else if (entry.name === 'unparseable wrapper') {
                fixture.fs.addFile(secret, '@echo unsafe');
            } else if (entry.name === 'incompatible version' || entry.name === 'missing app-server') {
                fixture.fs.addFile(secret);
                fixture.probe.fail(secret, entry.name === 'incompatible version'
                    ? 'Codex CLI version is incompatible'
                    : 'Codex App Server command is unavailable');
            }

            await assert.rejects(fixture.resolver.resolve(), error => {
                const runtimeError = error as Error;
                assert.match(runtimeError.message, entry.expected);
                assert.doesNotMatch(runtimeError.message, /must-not-leak|secret-/i);
                return true;
            });
            assert.equal(fixture.counters.system, 0);
            assert.equal(fixture.counters.managed, 0);
            assert.ok(fixture.probe.calls.length <= 1);
        });
    }
});

test('all implicit failures produce a bounded explicit no-runtime error', async () => {
    const system = Array.from({ length: 20 }, (_, index) => `C:\\secret-system-${index}\\codex.exe`);
    const managed = 'C:\\secret-managed\\codex.exe';
    const fixture = createResolver({ system, managed, environment: { OPENAI_API_KEY: 'must-not-leak' } });

    await assert.rejects(fixture.resolver.resolve(), error => {
        assert.ok(error instanceof RideCodexRuntimeUnavailableError);
        const runtimeError = error as RideCodexRuntimeUnavailableError;
        assert.match(runtimeError.message, /no compatible native Codex runtime/i);
        assert.ok(runtimeError.diagnostics.length > 0 && runtimeError.diagnostics.length <= 8);
        assert.ok(runtimeError.diagnostics.every((diagnostic: string) => diagnostic.length <= 160));
        assert.doesNotMatch(`${runtimeError.message} ${runtimeError.diagnostics.join(' ')}`, /must-not-leak|secret-system|secret-managed/i);
        return true;
    });
});

test('resolves cmd and PowerShell npm launchers to native optional-package executables without probing wrappers', async t => {
    const cases = [
        { wrapper: 'C:\\npm\\codex.cmd', nested: false },
        { wrapper: 'C:\\npm\\codex.ps1', nested: true }
    ] as const;

    for (const entry of cases) {
        await t.test(entry.wrapper.split('.').pop() ?? entry.wrapper, async () => {
            const fixture = createResolver({ environment: { RIDE_CODEX_PATH: entry.wrapper } });
            const npm = addWindowsNpmLayout(fixture.fs, entry.wrapper, { nested: entry.nested });

            const spec = await fixture.resolver.resolve();

            assertLaunchSpec(spec, { executable: npm.executable, source: 'override' });
            assert.deepEqual(fixture.probe.calls.map(call => call.executable), [npm.executable]);
            assert.ok(fixture.probe.calls.every(call => !/\.(cmd|ps1|js)$/i.test(call.executable)));
        });
    }
});

test('rejects unsafe or incompatible codex-package manifests before probing', async t => {
    const cases: ReadonlyArray<{
        readonly name: string;
        readonly manifest?: ManifestOverrides;
        readonly executableKind?: 'file' | 'directory' | 'symlink';
        readonly expected: RegExp;
    }> = [
        { name: 'layout version', manifest: { layoutVersion: 2 }, expected: /layout/i },
        { name: 'manifest version', manifest: { version: '0.143.0' }, expected: /version|compatible/i },
        { name: 'wrong target', manifest: { target: 'aarch64-pc-windows-msvc' }, expected: /target|architecture/i },
        { name: 'wrong variant', manifest: { variant: 'other' }, expected: /variant/i },
        { name: 'absolute entrypoint', manifest: { entrypoint: 'C:\\escape\\codex.exe' }, expected: /entrypoint/i },
        { name: 'parent traversal', manifest: { entrypoint: '..\\escape\\codex.exe' }, expected: /entrypoint|escape/i },
        { name: 'wrong entrypoint', manifest: { entrypoint: 'bin/other.exe' }, expected: /entrypoint/i },
        { name: 'symlink executable', executableKind: 'symlink', expected: /symlink|native|file/i },
        { name: 'directory executable', executableKind: 'directory', expected: /file/i }
    ];

    for (const [index, entry] of cases.entries()) {
        await t.test(entry.name, async () => {
            const wrapper = `C:\\npm\\codex-${index}.cmd`;
            const fixture = createResolver({ environment: { RIDE_CODEX_PATH: wrapper } });
            addWindowsNpmLayout(fixture.fs, wrapper, {
                manifest: entry.manifest,
                executableKind: entry.executableKind
            });

            await assert.rejects(fixture.resolver.resolve(), entry.expected);
            assert.equal(fixture.probe.calls.length, 0);
        });
    }
});

test('rejects wrapper and executable realpath escapes', async t => {
    await t.test('wrapper symlink', async () => {
        const wrapper = 'C:\\npm\\codex.cmd';
        const fixture = createResolver({ environment: { RIDE_CODEX_PATH: wrapper } });
        fixture.fs.addSymlink(wrapper, 'C:\\elsewhere\\codex.cmd');
        await assert.rejects(fixture.resolver.resolve(), /symlink|file/i);
        assert.equal(fixture.probe.calls.length, 0);
    });

    await t.test('executable parent escape', async () => {
        const wrapper = 'C:\\npm\\codex.cmd';
        const fixture = createResolver({ environment: { RIDE_CODEX_PATH: wrapper } });
        const npm = addWindowsNpmLayout(fixture.fs, wrapper);
        fixture.fs.addFile(npm.executable);
        fixture.fs.addSymlink(npm.executable, 'C:\\elsewhere\\codex.exe');
        await assert.rejects(fixture.resolver.resolve(), /symlink|escape|native/i);
        assert.equal(fixture.probe.calls.length, 0);
    });
});

test('normalizes POSIX native runtimes and rejects wrappers or non-executable files', async t => {
    await t.test('absolute executable', async () => {
        const fixture = createResolver({ platform: 'linux', arch: 'arm64', environment: { RIDE_CODEX_PATH: '/opt/codex/bin/codex' } });
        fixture.fs.addFile('/opt/codex/bin/codex', Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]), true);
        const spec = await fixture.resolver.resolve();
        assertLaunchSpec(spec, {
            executable: '/opt/codex/bin/codex',
            source: 'override',
            target: 'aarch64-unknown-linux-musl'
        });
    });

    for (const entry of [
        { name: 'relative', path: 'bin/codex', executable: true },
        { name: 'JavaScript wrapper', path: '/opt/codex/bin/codex.js', executable: true },
        { name: 'extensionless shebang wrapper', path: '/opt/codex/bin/codex', executable: true, content: '#!/usr/bin/env node\n' },
        { name: 'non-executable', path: '/opt/codex/bin/codex', executable: false }
    ]) {
        await t.test(entry.name, async () => {
            const fixture = createResolver({ platform: 'linux', arch: 'x64', environment: { RIDE_CODEX_PATH: entry.path } });
            fixture.fs.addFile(entry.path, entry.content ?? Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]), entry.executable);
            await assert.rejects(fixture.resolver.resolve(), /absolute|native|executable/i);
            assert.equal(fixture.probe.calls.length, 0);
        });
    }
});

test('accepts native Mach-O magic without executing a wrapper', async () => {
    const fixture = createResolver({
        platform: 'darwin',
        arch: 'arm64',
        environment: { RIDE_CODEX_PATH: '/Applications/Codex.app/Contents/MacOS/codex' }
    });
    fixture.fs.addFile(
        '/Applications/Codex.app/Contents/MacOS/codex',
        Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe]),
        true
    );

    const spec = await fixture.resolver.resolve();

    assertLaunchSpec(spec, {
        executable: '/Applications/Codex.app/Contents/MacOS/codex',
        source: 'override',
        target: 'aarch64-apple-darwin'
    });
});

test('maps every supported platform architecture and rejects unsupported combinations', () => {
    assert.equal(targetForPlatform('win32', 'x64'), 'x86_64-pc-windows-msvc');
    assert.equal(targetForPlatform('win32', 'arm64'), 'aarch64-pc-windows-msvc');
    assert.equal(targetForPlatform('darwin', 'x64'), 'x86_64-apple-darwin');
    assert.equal(targetForPlatform('darwin', 'arm64'), 'aarch64-apple-darwin');
    assert.equal(targetForPlatform('linux', 'x64'), 'x86_64-unknown-linux-musl');
    assert.equal(targetForPlatform('linux', 'arm64'), 'aarch64-unknown-linux-musl');
    assert.throws(() => targetForPlatform('freebsd', 'x64'), /unsupported.*platform/i);
    assert.throws(() => targetForPlatform('win32', 'ia32'), /unsupported.*architecture/i);
});

test('probe accepts only compatible codex-cli output and proven app-server help', async t => {
    await t.test('success uses separate bounded no-shell commands', async () => {
        const calls: Array<{ executable: string; args: readonly string[]; timeoutMs: number; maxOutputBytes: number }> = [];
        const probe = new RideCodexRuntimeProbe({
            runner: {
                run: async (executable: string, args: readonly string[], limits: ProbeLimits) => {
                    calls.push({ executable, args, ...limits });
                    return args[0] === '--version'
                        ? { stdout: 'codex-cli 0.144.0\n', stderr: '' }
                        : { stdout: 'Usage: codex app-server [OPTIONS]\n', stderr: '' };
                }
            },
            versionTimeoutMs: 1_000,
            helpTimeoutMs: 2_000,
            maxOutputBytes: 4_096
        });

        const result = await probe.probe(WINDOWS_NATIVE, WINDOWS_TARGET);

        assert.deepEqual(result, { version: '0.144.0', target: WINDOWS_TARGET });
        assert.deepEqual(calls, [
            { executable: WINDOWS_NATIVE, args: ['--version'], timeoutMs: 1_000, maxOutputBytes: 4_096 },
            { executable: WINDOWS_NATIVE, args: ['app-server', '--help'], timeoutMs: 2_000, maxOutputBytes: 4_096 }
        ]);
    });

    const cases: ReadonlyArray<{ name: string; version: string; help: string; expected: RegExp }> = [
        { name: 'malformed version', version: 'Codex version unknown', help: 'Usage: codex app-server', expected: /version/i },
        { name: 'old version', version: 'codex-cli 0.143.0', help: 'Usage: codex app-server', expected: /compatible|0\.144\.0/i },
        { name: 'new version', version: 'codex-cli 0.145.0', help: 'Usage: codex app-server', expected: /compatible|0\.144\.0/i },
        { name: 'unproven help', version: 'codex-cli 0.144.0', help: 'Codex commands', expected: /app.server/i }
    ];
    for (const entry of cases) {
        await t.test(entry.name, async () => {
            const probe = new RideCodexRuntimeProbe({
                runner: {
                    run: async (_executable: string, args: readonly string[]) => args[0] === '--version'
                        ? { stdout: entry.version, stderr: '' }
                        : { stdout: entry.help, stderr: '' }
                }
            });
            await assert.rejects(probe.probe(WINDOWS_NATIVE, WINDOWS_TARGET), entry.expected);
        });
    }
});

class FakeSpawnedProcess extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    killed = false;

    kill(): boolean {
        this.killed = true;
        return true;
    }
}

test('bounded exec runner disables shell and handles output, timeout, exit, signal, and ENOENT', async t => {
    await t.test('no shell success', async () => {
        const child = new FakeSpawnedProcess();
        let spawnOptions: Record<string, unknown> | undefined;
        const spawn: RideCodexSpawn = (_executable: string, _args: readonly string[], options: object) => {
            spawnOptions = options as unknown as Record<string, unknown>;
            queueMicrotask(() => {
                child.stdout.end('codex-cli 0.144.0\n');
                child.stderr.end();
                child.emit('close', 0, null);
            });
            return child;
        };
        const runner = new RideCodexBoundedExecRunner({ spawn });
        const result = await runner.run(WINDOWS_NATIVE, ['--version'], { timeoutMs: 100, maxOutputBytes: 1_024 });
        assert.equal(spawnOptions?.shell, false);
        assert.deepEqual(spawnOptions?.stdio, ['ignore', 'pipe', 'pipe']);
        assert.equal(result.stdout, 'codex-cli 0.144.0\n');
    });

    await t.test('output limit', async () => {
        const child = new FakeSpawnedProcess();
        const runner = new RideCodexBoundedExecRunner({ spawn: () => child });
        const result = runner.run(WINDOWS_NATIVE, ['--version'], { timeoutMs: 100, maxOutputBytes: 8 });
        child.stdout.write('0123456789');
        await assert.rejects(result, error => {
            const commandError = error as RideCodexProbeCommandError;
            return commandError instanceof RideCodexProbeCommandError && commandError.reason === 'max-output';
        });
        assert.equal(child.killed, true);
    });

    await t.test('timeout', async () => {
        const child = new FakeSpawnedProcess();
        const runner = new RideCodexBoundedExecRunner({ spawn: () => child });
        await assert.rejects(
            runner.run(WINDOWS_NATIVE, ['--version'], { timeoutMs: 5, maxOutputBytes: 100 }),
            error => {
                const commandError = error as RideCodexProbeCommandError;
                return commandError instanceof RideCodexProbeCommandError && commandError.reason === 'timeout';
            }
        );
        assert.equal(child.killed, true);
    });

    await t.test('nonzero exit', async () => {
        const child = new FakeSpawnedProcess();
        const runner = new RideCodexBoundedExecRunner({ spawn: () => {
            queueMicrotask(() => child.emit('close', 7, null));
            return child;
        } });
        await assert.rejects(
            runner.run(WINDOWS_NATIVE, ['--version'], { timeoutMs: 100, maxOutputBytes: 100 }),
            error => {
                const commandError = error as RideCodexProbeCommandError;
                return commandError instanceof RideCodexProbeCommandError && commandError.reason === 'exit';
            }
        );
    });

    await t.test('signal', async () => {
        const child = new FakeSpawnedProcess();
        const runner = new RideCodexBoundedExecRunner({ spawn: () => {
            queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
            return child;
        } });
        await assert.rejects(
            runner.run(WINDOWS_NATIVE, ['--version'], { timeoutMs: 100, maxOutputBytes: 100 }),
            error => {
                const commandError = error as RideCodexProbeCommandError;
                return commandError instanceof RideCodexProbeCommandError && commandError.reason === 'signal';
            }
        );
    });

    await t.test('ENOENT', async () => {
        const child = new FakeSpawnedProcess();
        const runner = new RideCodexBoundedExecRunner({ spawn: () => {
            queueMicrotask(() => {
                const error = new Error('spawn secret path ENOENT') as NodeJS.ErrnoException;
                error.code = 'ENOENT';
                child.emit('error', error);
            });
            return child;
        } });
        await assert.rejects(
            runner.run(WINDOWS_NATIVE, ['--version'], { timeoutMs: 100, maxOutputBytes: 100 }),
            error => {
                const commandError = error as RideCodexProbeCommandError;
                return commandError instanceof RideCodexProbeCommandError
                    && commandError.reason === 'not-found'
                    && !commandError.message.includes('secret path');
            }
        );
    });
});

test('probe diagnostics stay bounded and never include command output or environment secrets', async () => {
    const secret = 'OPENAI_API_KEY=must-not-leak';
    const probe = new RideCodexRuntimeProbe({
        runner: {
            run: async () => {
                throw new RideCodexProbeCommandError('exit', `${secret}${'x'.repeat(100_000)}`);
            }
        }
    });

    await assert.rejects(probe.probe(WINDOWS_NATIVE, WINDOWS_TARGET), error => {
        const message = (error as Error).message;
        assert.ok(message.length <= 200);
        assert.doesNotMatch(message, /must-not-leak|OPENAI_API_KEY|x{20}/);
        return true;
    });
});
