/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { constants as fsConstants, promises as realFs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname as nativeDirname, join as nativeJoin, relative as nativeRelative, sep as nativeSeparator, win32 } from 'node:path';
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
import {
    RuntimeTarget,
    runtimeManifestEntryDigest,
    runtimeManifestEntryForTarget
} from '../src/node/ride-codex-runtime-manifest';
import { ValidatedManagedRuntime } from '../src/node/ride-codex-runtime-store';

const WINDOWS_TARGET = 'x86_64-pc-windows-msvc';
const WINDOWS_NATIVE = 'C:\\tools\\codex.exe';
const WINDOWS_RUNTIME = runtimeManifestEntryForTarget(WINDOWS_TARGET);
const WINDOWS_MANIFEST_DIGEST = runtimeManifestEntryDigest(WINDOWS_RUNTIME);

function validatedManagedRuntime(
    executable: string,
    overrides: Partial<Pick<ValidatedManagedRuntime, 'version' | 'target' | 'manifestDigest'>> = {}
): ValidatedManagedRuntime {
    const version = overrides.version ?? WINDOWS_RUNTIME.version;
    const target = overrides.target ?? WINDOWS_RUNTIME.target;
    const manifestDigest = overrides.manifestDigest ?? WINDOWS_MANIFEST_DIGEST;
    const relativePath = `versions/v-${version}--${target}--${manifestDigest.slice('sha256-'.length, 'sha256-'.length + 16)}`;
    const directory = win32.dirname(executable);
    const rootIdentity = Object.freeze({ dev: '1', ino: '2', size: '0', birthtimeNs: '3', ctimeNs: '4' });
    const pointer = Object.freeze({
        schemaVersion: 1 as const,
        version,
        target,
        manifestDigest,
        relativePath,
        executableRelativePath: `package/vendor/${target}/bin/${target.includes('windows') ? 'codex.exe' : 'codex'}`,
        treeDigest: `sha256-${'1'.repeat(64)}`,
        treeEntries: 1,
        treeReadBytes: '1',
        treePathBytes: 1,
        rootIdentity
    });
    return Object.freeze({
        version,
        target,
        manifestDigest,
        relativePath,
        directory,
        executable,
        pointer
    });
}

function peHeader(arch: 'x64' | 'arm64'): Uint8Array {
    const header = Buffer.alloc(512);
    header.write('MZ', 0, 'ascii');
    header.writeUInt32LE(0x80, 0x3c);
    header.write('PE\0\0', 0x80, 'binary');
    header.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 0x84);
    return header;
}

function elfHeader(arch: 'x64' | 'arm64'): Uint8Array {
    const header = Buffer.alloc(64);
    header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    header.writeUInt16LE(arch === 'x64' ? 62 : 183, 18);
    return header;
}

function machoHeader(arch: 'x64' | 'arm64'): Uint8Array {
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4);
    return header;
}

function machoUniversalHeader(): Uint8Array {
    const header = Buffer.alloc(8 + (2 * 20));
    header.writeUInt32BE(0xcafebabe, 0);
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(0x01000007, 8);
    header.writeUInt32BE(0x0100000c, 28);
    return header;
}

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
    readonly signal?: AbortSignal;
}

class VirtualFileSystem implements RideCodexRuntimeFileSystem {
    readonly calls: string[] = [];
    private readonly files = new Map<string, VirtualFile>();

    addFile(path: string, content: string | Uint8Array = peHeader('x64'), executable = true): void {
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

    async readLink(path: string): Promise<string> {
        this.calls.push(`readlink:${path}`);
        const file = this.files.get(this.key(path));
        if (!file || file.kind !== 'symlink' || !file.realPath) {
            throw new Error('not a symlink');
        }
        return file.realPath;
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
    readonly calls: Array<{ executable: string }> = [];
    private readonly failures = new Map<string, Error>();
    private readonly versions = new Map<string, string>();
    delay: Promise<void> | undefined;

    fail(path: string, message: string): void {
        this.failures.set(this.key(path), new Error(message));
    }

    version(path: string, version: string): void {
        this.versions.set(this.key(path), version);
    }

    async probe(
        executable: string,
        request: { readonly signal?: AbortSignal } = {}
    ): Promise<{ readonly version: string }> {
        this.calls.push({ executable });
        if (this.delay) {
            await new Promise<void>((resolve, reject) => {
                let settled = false;
                const finish = (callback: () => void): void => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    request.signal?.removeEventListener('abort', onAbort);
                    callback();
                };
                const onAbort = (): void => finish(() => reject(new Error('Codex probe was aborted.')));
                request.signal?.addEventListener('abort', onAbort, { once: true });
                if (request.signal?.aborted) {
                    onAbort();
                    return;
                }
                this.delay!.then(
                    () => finish(resolve),
                    error => finish(() => reject(error))
                );
            });
        }
        const failure = this.failures.get(this.key(executable));
        if (failure) {
            throw failure;
        }
        return { version: this.versions.get(this.key(executable)) ?? '0.144.0' };
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
            return options.managed ? validatedManagedRuntime(options.managed) : undefined;
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

test('managed runtimes require exact reviewed metadata before probing and exact pointer version after probing', async t => {
    const createManagedResolver = (
        runtime: ValidatedManagedRuntime,
        header: Uint8Array = peHeader('x64')
    ): { readonly resolver: RideCodexRuntimeResolver; readonly probe: FakeProbe } => {
        const filesystem = new VirtualFileSystem();
        const probe = new FakeProbe();
        filesystem.addFile(runtime.executable, header);
        return {
            probe,
            resolver: new RideCodexRuntimeResolver({
                platform: 'win32',
                arch: 'x64',
                filesystem,
                probe,
                readEnvironment: () => ({}),
                readUserOverride: () => undefined,
                findSystemCandidates: () => [],
                managedRuntimeStore: { readActiveRuntime: async () => runtime }
            })
        };
    };

    await t.test('rejects a pointer digest that differs from the current reviewed target entry without probing', async () => {
        const runtime = validatedManagedRuntime(WINDOWS_NATIVE, {
            manifestDigest: `sha256-${'f'.repeat(64)}`
        });
        const fixture = createManagedResolver(runtime);

        await assert.rejects(fixture.resolver.resolve(), /No compatible native Codex runtime/i);
        assert.deepEqual(fixture.probe.calls, []);
    });

    await t.test('rejects a pointer version that differs from the current reviewed version without probing', async () => {
        const runtime = validatedManagedRuntime(WINDOWS_NATIVE, { version: '0.143.0' });
        const fixture = createManagedResolver(runtime);

        await assert.rejects(fixture.resolver.resolve(), /No compatible native Codex runtime/i);
        assert.deepEqual(fixture.probe.calls, []);
    });

    await t.test('rejects a pointer target that differs from the current platform without probing', async () => {
        const target: RuntimeTarget = 'aarch64-pc-windows-msvc';
        const runtime = validatedManagedRuntime(WINDOWS_NATIVE, {
            target,
            manifestDigest: runtimeManifestEntryDigest(runtimeManifestEntryForTarget(target))
        });
        const fixture = createManagedResolver(runtime);

        await assert.rejects(fixture.resolver.resolve(), /No compatible native Codex runtime/i);
        assert.deepEqual(fixture.probe.calls, []);
    });

    await t.test('rejects a native executable whose header differs from the exact pointer target before probing', async () => {
        const runtime = validatedManagedRuntime(WINDOWS_NATIVE);
        const fixture = createManagedResolver(runtime, peHeader('arm64'));

        await assert.rejects(fixture.resolver.resolve(), /No compatible native Codex runtime/i);
        assert.deepEqual(fixture.probe.calls, []);
    });

    await t.test('rejects probe output that is semantically compatible but not exactly equal to the pointer version', async () => {
        const runtime = validatedManagedRuntime(WINDOWS_NATIVE);
        const fixture = createManagedResolver(runtime);
        fixture.probe.version(runtime.executable, '0.144.00');

        await assert.rejects(fixture.resolver.resolve(), /No compatible native Codex runtime/i);
        assert.deepEqual(fixture.probe.calls.map(call => call.executable), [runtime.executable]);
    });

    await t.test('accepts an exact frozen pointer and returns its precise managed version and target', async () => {
        const runtime = validatedManagedRuntime(WINDOWS_NATIVE);
        const fixture = createManagedResolver(runtime);

        const spec = await fixture.resolver.resolve();

        assertLaunchSpec(spec, { executable: runtime.executable, source: 'managed', target: runtime.target });
        assert.equal(spec.version, runtime.version);
        assert.equal(Object.isFrozen(runtime), true);
        assert.equal(Object.isFrozen(runtime.pointer), true);
    });
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

test('production default environment provider accepts native process.env without retaining it', async () => {
    const fs = new VirtualFileSystem();
    const probe = new FakeProbe();
    fs.addFile(WINDOWS_NATIVE, peHeader('x64'));
    let discoveredEnvironment: Readonly<Record<string, string | undefined>> | undefined;
    const overrideKeys = Object.keys(process.env).filter(key => key.toLowerCase() === 'ride_codex_path');
    const savedOverrides = overrideKeys.map(key => [key, process.env[key]] as const);
    for (const key of overrideKeys) {
        delete process.env[key];
    }

    try {
        const resolver = new RideCodexRuntimeResolver({
            platform: 'win32',
            arch: 'x64',
            filesystem: fs,
            probe,
            findSystemCandidates: environment => {
                discoveredEnvironment = environment;
                return [WINDOWS_NATIVE];
            }
        });

        const spec = await resolver.resolve();

        assertLaunchSpec(spec, { executable: WINDOWS_NATIVE, source: 'system' });
        assert.ok(discoveredEnvironment);
        assert.notEqual(discoveredEnvironment, process.env);
        assert.equal(Object.getPrototypeOf(discoveredEnvironment), null);
    } finally {
        for (const [key, value] of savedOverrides) {
            if (value !== undefined) {
                process.env[key] = value;
            }
        }
    }
});

test('runtime providers enforce bounded typed outputs and never disclose provider failures', async t => {
    const unsafeProviderError = (): Error => new Error(
        `OPENAI_API_KEY=provider-secret Authorization=Bearer-token https://user:password@example.invalid/${'x'.repeat(10_000)}`
    );
    const assertSafe = (error: unknown): boolean => {
        const runtimeError = error as Error & { readonly diagnostics?: readonly string[] };
        const visible = `${runtimeError.message}\n${runtimeError.stack ?? ''}\n${runtimeError.diagnostics?.join('\n') ?? ''}`;
        assert.doesNotMatch(visible, /provider-secret|Bearer-token|user:password|x{32}/i);
        assert.ok(runtimeError.message.length <= 240);
        assert.ok((runtimeError.diagnostics ?? []).every(diagnostic => diagnostic.length <= 160));
        return true;
    };

    await t.test('environment provider exceptions fail closed with a generic actionable error', async () => {
        let userReads = 0;
        const resolver = new RideCodexRuntimeResolver({
            platform: 'win32', arch: 'x64', filesystem: new VirtualFileSystem(), probe: new FakeProbe(),
            readEnvironment: () => { throw unsafeProviderError(); },
            readUserOverride: () => { userReads += 1; return WINDOWS_NATIVE; }
        });
        await assert.rejects(resolver.resolve(), error => {
            assert.ok(error instanceof RideCodexRuntimeConfigurationError);
            assert.match((error as Error).message, /environment|configure|setting/i);
            return assertSafe(error);
        });
        assert.equal(userReads, 0);
    });

    await t.test('environment provider accepts own data properties from an unusual prototype without inheriting it', async () => {
        const inheritedOverride = 'C:\\inherited-secret\\codex.exe';
        const environment = Object.create({ RIDE_CODEX_PATH: inheritedOverride }) as Record<string, string | undefined>;
        Object.defineProperty(environment, 'PATH', {
            configurable: true,
            enumerable: true,
            value: 'C:\\safe-bin',
            writable: true
        });
        const fs = new VirtualFileSystem();
        fs.addFile(WINDOWS_NATIVE, peHeader('x64'));
        let receivedEnvironment: Readonly<Record<string, string | undefined>> | undefined;
        const resolver = new RideCodexRuntimeResolver({
            platform: 'win32', arch: 'x64', filesystem: fs, probe: new FakeProbe(),
            readEnvironment: () => environment,
            findSystemCandidates: boundedEnvironment => {
                receivedEnvironment = boundedEnvironment;
                return [WINDOWS_NATIVE];
            }
        });

        const spec = await resolver.resolve();

        assertLaunchSpec(spec, { executable: WINDOWS_NATIVE, source: 'system' });
        assert.ok(receivedEnvironment);
        assert.notEqual(receivedEnvironment, environment);
        assert.equal(Object.getPrototypeOf(receivedEnvironment), null);
        assert.equal(receivedEnvironment.PATH, 'C:\\safe-bin');
        assert.equal(Object.prototype.hasOwnProperty.call(receivedEnvironment, 'RIDE_CODEX_PATH'), false);
    });

    await t.test('environment provider rejects accessors without executing getters', async () => {
        let getterCalls = 0;
        let systemReads = 0;
        const environment = Object.create(null) as Record<string, string | undefined>;
        Object.defineProperty(environment, 'PATH', {
            enumerable: true,
            get: () => {
                getterCalls += 1;
                return 'C:\\must-not-run';
            }
        });
        const resolver = new RideCodexRuntimeResolver({
            platform: 'win32', arch: 'x64', filesystem: new VirtualFileSystem(), probe: new FakeProbe(),
            readEnvironment: () => environment,
            findSystemCandidates: () => { systemReads += 1; return []; }
        });

        await assert.rejects(resolver.resolve(), error => {
            assert.ok(error instanceof RideCodexRuntimeConfigurationError);
            return assertSafe(error);
        });
        assert.equal(getterCalls, 0);
        assert.equal(systemReads, 0);
    });

    await t.test('environment provider converts descriptor proxy failures into a generic safe error', async () => {
        const environment = new Proxy(Object.create(null) as Record<string, string | undefined>, {
            ownKeys: () => ['PATH'],
            getOwnPropertyDescriptor: () => { throw unsafeProviderError(); }
        });
        const resolver = new RideCodexRuntimeResolver({
            platform: 'win32', arch: 'x64', filesystem: new VirtualFileSystem(), probe: new FakeProbe(),
            readEnvironment: () => environment
        });

        await assert.rejects(resolver.resolve(), error => {
            assert.ok(error instanceof RideCodexRuntimeConfigurationError);
            return assertSafe(error);
        });
    });

    await t.test('environment provider rejects invalid and oversized records safely', async () => {
        const tooManyEntries = Object.fromEntries(
            Array.from({ length: 1_025 }, (_, index) => [`KEY_${index}`, 'value'])
        );
        for (const environment of [
            null,
            [] as unknown[],
            Promise.resolve({ PATH: 'C:\\bin' }),
            { PATH: 42 },
            { PATH: 'x'.repeat(200_000) },
            { ['K'.repeat(1_025)]: 'value' },
            tooManyEntries
        ]) {
            const resolver = new RideCodexRuntimeResolver({
                platform: 'win32', arch: 'x64', filesystem: new VirtualFileSystem(), probe: new FakeProbe(),
                readEnvironment: () => environment as unknown as Readonly<Record<string, string | undefined>>
            });
            await assert.rejects(resolver.resolve(), error => {
                assert.ok(error instanceof RideCodexRuntimeConfigurationError);
                return assertSafe(error);
            });
        }
    });

    await t.test('user override exceptions and invalid values fail closed without fallback', async () => {
        for (const readUserOverride of [
            () => { throw unsafeProviderError(); },
            () => 42 as unknown as string,
            () => 'C:\\'.concat('x'.repeat(100_000))
        ]) {
            let systemReads = 0;
            const resolver = new RideCodexRuntimeResolver({
                platform: 'win32', arch: 'x64', filesystem: new VirtualFileSystem(), probe: new FakeProbe(),
                readEnvironment: () => ({}),
                readUserOverride,
                findSystemCandidates: () => { systemReads += 1; return [WINDOWS_NATIVE]; }
            });
            await assert.rejects(resolver.resolve(), error => {
                assert.ok(error instanceof RideCodexRuntimeConfigurationError);
                assert.match((error as Error).message, /setting|configure|override/i);
                return assertSafe(error);
            });
            assert.equal(systemReads, 0);
        }
    });

    await t.test('system discovery exceptions and invalid values continue to a managed runtime', async () => {
        for (const findSystemCandidates of [
            () => { throw unsafeProviderError(); },
            () => ({ secret: 'provider-secret' }) as unknown as readonly string[],
            () => [42] as unknown as readonly string[],
            () => ['C:\\'.concat('x'.repeat(100_000))]
        ]) {
            const fs = new VirtualFileSystem();
            fs.addFile(WINDOWS_NATIVE, peHeader('x64'));
            const resolver = new RideCodexRuntimeResolver({
                platform: 'win32', arch: 'x64', filesystem: fs, probe: new FakeProbe(),
                readEnvironment: () => ({}),
                findSystemCandidates,
                readManagedActiveRuntime: () => validatedManagedRuntime(WINDOWS_NATIVE)
            });
            const spec = await resolver.resolve();
            assertLaunchSpec(spec, { executable: WINDOWS_NATIVE, source: 'managed' });
            assert.match(spec.diagnostics.join(' '), /system.*unavailable|system.*invalid/i);
            assertSafe({ message: '', diagnostics: spec.diagnostics });
        }
    });

    await t.test('managed provider exceptions and invalid values become generic unavailable diagnostics', async () => {
        for (const readManagedActiveRuntime of [
            () => { throw unsafeProviderError(); },
            () => ({ secret: 'provider-secret' }) as unknown as ValidatedManagedRuntime,
            () => 'C:\\'.concat('x'.repeat(100_000)) as unknown as ValidatedManagedRuntime
        ]) {
            const resolver = new RideCodexRuntimeResolver({
                platform: 'win32', arch: 'x64', filesystem: new VirtualFileSystem(), probe: new FakeProbe(),
                readEnvironment: () => ({}),
                findSystemCandidates: () => [],
                readManagedActiveRuntime
            });
            await assert.rejects(resolver.resolve(), error => {
                assert.ok(error instanceof RideCodexRuntimeUnavailableError);
                assert.match((error as RideCodexRuntimeUnavailableError).diagnostics.join(' '), /managed.*unavailable|managed.*invalid/i);
                return assertSafe(error);
            });
        }
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
        fixture.fs.addFile('/opt/codex/bin/codex', elfHeader('arm64'), true);
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
            fixture.fs.addFile(entry.path, entry.content ?? elfHeader('x64'), entry.executable);
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
        machoHeader('arm64'),
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

        const result = await probe.probe(WINDOWS_NATIVE);

        assert.deepEqual(result, { version: '0.144.0' });
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
            await assert.rejects(probe.probe(WINDOWS_NATIVE), entry.expected);
        });
    }
});

class FakeSpawnedProcess extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly signals: Array<NodeJS.Signals | number | undefined> = [];
    killed = false;
    onKill: ((signal: NodeJS.Signals | number | undefined) => void) | undefined;

    kill(signal?: NodeJS.Signals | number): boolean {
        this.killed = true;
        this.signals.push(signal);
        this.onKill?.(signal);
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

    await assert.rejects(probe.probe(WINDOWS_NATIVE), error => {
        const message = (error as Error).message;
        assert.ok(message.length <= 200);
        assert.doesNotMatch(message, /must-not-leak|OPENAI_API_KEY|x{20}/);
        return true;
    });
});

test('probe subprocess receives only a bounded channel-neutral environment', async () => {
    const child = new FakeSpawnedProcess();
    let spawnOptions: Record<string, unknown> | undefined;
    const runner = new RideCodexBoundedExecRunner({
        platform: 'win32',
        readEnvironment: () => ({
            SystemRoot: 'C:\\Windows',
            TEMP: 'C:\\Temp',
            LANG: 'zh_CN.UTF-8',
            PATH: 'C:\\unneeded',
            OPENAI_API_KEY: 'api-secret',
            access_token: 'token-secret',
            Authorization: 'auth-secret',
            CLIENT_SECRET: 'client-secret',
            DB_PASSWORD: 'password-secret',
            AWS_CREDENTIAL_FILE: 'credential-secret',
            RIDE_CODEX_PATH: 'C:\\channel\\codex.exe',
            CODEX_HOME: 'C:\\channel\\home',
            HUGE: 'x'.repeat(100_000)
        }),
        spawn: (_executable: string, _args: readonly string[], options: object) => {
            spawnOptions = options as Record<string, unknown>;
            queueMicrotask(() => child.emit('close', 0, null));
            return child;
        }
    });

    await runner.run(WINDOWS_NATIVE, ['--version'], { timeoutMs: 100, maxOutputBytes: 1_024 });

    const environment = spawnOptions?.env as Readonly<Record<string, string>> | undefined;
    assert.deepEqual(environment, {
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Temp',
        LANG: 'zh_CN.UTF-8'
    });
    assert.doesNotMatch(JSON.stringify(environment), /api-secret|token-secret|auth-secret|client-secret|password-secret|credential-secret|channel/i);
    assert.ok(Buffer.byteLength(JSON.stringify(environment)) < 4_096);
});

test('failed resolutions retry, successful resolutions cache, and invalidate queues a fresh generation', async () => {
    let configuredPath = 'C:\\missing\\codex.exe';
    let environmentReads = 0;
    const fs = new VirtualFileSystem();
    const probe = new FakeProbe();
    const resolver = new RideCodexRuntimeResolver({
        platform: 'win32',
        arch: 'x64',
        filesystem: fs,
        probe,
        readEnvironment: () => {
            environmentReads += 1;
            return { RIDE_CODEX_PATH: configuredPath };
        }
    });

    await assert.rejects(resolver.resolve(), RideCodexRuntimeConfigurationError);
    configuredPath = WINDOWS_NATIVE;
    fs.addFile(WINDOWS_NATIVE, peHeader('x64'));
    const recovered = await resolver.resolve();
    assertLaunchSpec(recovered, { executable: WINDOWS_NATIVE, source: 'override' });
    assert.equal(environmentReads, 2);
    assert.strictEqual(await resolver.resolve(), recovered);
    assert.equal(environmentReads, 2);

    const firstPath = 'C:\\first-generation\\codex.exe';
    const secondPath = 'C:\\second-generation\\codex.exe';
    const refreshFs = new VirtualFileSystem();
    refreshFs.addFile(firstPath, peHeader('x64'));
    refreshFs.addFile(secondPath, peHeader('x64'));
    let refreshPath = firstPath;
    let releaseFirstProbe: (() => void) | undefined;
    let markFirstProbeStarted: (() => void) | undefined;
    const firstProbeStarted = new Promise<void>(resolve => {
        markFirstProbeStarted = resolve;
    });
    const firstProbeGate = new Promise<void>(resolve => {
        releaseFirstProbe = resolve;
    });
    const calls: string[] = [];
    let activeProbes = 0;
    let maximumActiveProbes = 0;
    const refreshProbe: RideCodexRuntimeProbeLike = {
        probe: async executable => {
            calls.push(executable);
            activeProbes += 1;
            maximumActiveProbes = Math.max(maximumActiveProbes, activeProbes);
            try {
                if (calls.length === 1) {
                    markFirstProbeStarted?.();
                    await firstProbeGate;
                }
                return { version: '0.144.0' };
            } finally {
                activeProbes -= 1;
            }
        }
    };
    const refreshResolver = new RideCodexRuntimeResolver({
        platform: 'win32', arch: 'x64', filesystem: refreshFs, probe: refreshProbe,
        readEnvironment: () => ({ RIDE_CODEX_PATH: refreshPath })
    });

    const stale = refreshResolver.resolve();
    await firstProbeStarted;
    refreshPath = secondPath;
    refreshResolver.invalidate();
    const refreshed = refreshResolver.resolve();
    const concurrentRefresh = refreshResolver.resolve();

    assert.notStrictEqual(refreshed, stale);
    assert.strictEqual(concurrentRefresh, refreshed);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [firstPath]);
    assert.equal(maximumActiveProbes, 1);

    releaseFirstProbe?.();
    const staleSpec = await stale;
    const refreshedSpec = await refreshed;
    assertLaunchSpec(staleSpec, { executable: firstPath, source: 'override' });
    assertLaunchSpec(refreshedSpec, { executable: secondPath, source: 'override' });
    assert.deepEqual(calls, [firstPath, secondPath]);
    assert.equal(maximumActiveProbes, 1);
    assert.strictEqual(await refreshResolver.resolve(), refreshedSpec);

    assert.equal(environmentReads, 2);
});

test('runtime discovery bounds real probes, deadlines, blocking filesystem work, and network paths', async t => {
    await t.test('hundreds of existing candidates consume only the configured probe budget', async () => {
        const fs = new VirtualFileSystem();
        const probe = new FakeProbe();
        const candidates = Array.from({ length: 200 }, (_, index) => `C:\\candidate-${index}\\codex.exe`);
        for (const candidate of candidates) {
            fs.addFile(candidate, peHeader('x64'));
            probe.fail(candidate, 'Codex App Server command is unavailable');
        }
        const resolver = new RideCodexRuntimeResolver({
            platform: 'win32',
            arch: 'x64',
            filesystem: fs,
            probe,
            readEnvironment: () => ({}),
            findSystemCandidates: () => candidates,
            maxSystemProbes: 3,
            discoveryTimeoutMs: 500
        });

        await assert.rejects(resolver.resolve(), RideCodexRuntimeUnavailableError);
        assert.equal(probe.calls.length, 3);
    });

    await t.test('deadline stops a hanging probe and prevents later candidates from starting', async () => {
        const first = 'C:\\first\\codex.exe';
        const second = 'C:\\second\\codex.exe';
        const fs = new VirtualFileSystem();
        fs.addFile(first, peHeader('x64'));
        fs.addFile(second, peHeader('x64'));
        const probe = new FakeProbe();
        probe.delay = new Promise<void>(() => undefined);
        const resolver = new RideCodexRuntimeResolver({
            platform: 'win32', arch: 'x64', filesystem: fs, probe,
            readEnvironment: () => ({}), findSystemCandidates: () => [first, second],
            discoveryTimeoutMs: 20
        });
        const guard = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('test guard expired')), 150));

        await assert.rejects(Promise.race([resolver.resolve(), guard]), /deadline|timed out|time limit/i);
        assert.equal(probe.calls.length, 1);
    });

    await t.test('deadline also bounds injected filesystem operations', async () => {
        const fs = new VirtualFileSystem();
        fs.lstat = async () => new Promise<RideCodexRuntimeFileStat>(() => undefined);
        const resolver = new RideCodexRuntimeResolver({
            platform: 'win32', arch: 'x64', filesystem: fs, probe: new FakeProbe(),
            readEnvironment: () => ({ RIDE_CODEX_PATH: WINDOWS_NATIVE }), discoveryTimeoutMs: 20
        });
        const guard = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('test guard expired')), 150));
        await assert.rejects(Promise.race([resolver.resolve(), guard]), /deadline|timed out|time limit/i);
    });

    await t.test('AbortSignal cancels an in-flight probe without starting another candidate', async () => {
        const controller = new AbortController();
        const first = 'C:\\abort-first\\codex.exe';
        const second = 'C:\\abort-second\\codex.exe';
        const fs = new VirtualFileSystem();
        fs.addFile(first, peHeader('x64'));
        fs.addFile(second, peHeader('x64'));
        const probe = new FakeProbe();
        probe.delay = new Promise<void>(() => undefined);
        const resolver = new RideCodexRuntimeResolver({
            platform: 'win32', arch: 'x64', filesystem: fs, probe,
            readEnvironment: () => ({}), findSystemCandidates: () => [first, second],
            discoveryTimeoutMs: 1_000, signal: controller.signal
        });
        const resolution = resolver.resolve();
        await new Promise(resolve => setImmediate(resolve));
        controller.abort();
        await assert.rejects(resolution, /aborted/i);
        assert.equal(probe.calls.length, 1);
    });

    await t.test('explicit UNC is actionable while implicit UNC is skipped before filesystem access', async () => {
        const unc = '\\\\offline-host\\share\\codex.exe';
        const explicitFs = new VirtualFileSystem();
        const explicit = new RideCodexRuntimeResolver({
            platform: 'win32', arch: 'x64', filesystem: explicitFs, probe: new FakeProbe(),
            readEnvironment: () => ({ RIDE_CODEX_PATH: unc })
        });
        await assert.rejects(explicit.resolve(), /UNC|network/i);
        assert.deepEqual(explicitFs.calls, []);

        const local = 'C:\\local\\codex.exe';
        const implicit = createResolver({ system: [unc, local] });
        implicit.fs.addFile(local, peHeader('x64'));
        const spec = await implicit.resolver.resolve();
        assertLaunchSpec(spec, { executable: local, source: 'system' });
        assert.equal(implicit.fs.calls.some(call => call.includes('offline-host')), false);
    });
});

test('probe timeout escalates termination, settles once, and clears grace timers', async t => {
    await t.test('POSIX sends SIGTERM then SIGKILL and waits for close', async () => {
        const child = new FakeSpawnedProcess();
        child.onKill = signal => {
            if (signal === 'SIGKILL') {
                queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
            }
        };
        const runner = new RideCodexBoundedExecRunner({
            platform: 'linux', spawn: () => child, terminationGraceMs: 5, terminationHardLimitMs: 50
        });
        await assert.rejects(
            runner.run('/opt/codex', ['--version'], { timeoutMs: 5, maxOutputBytes: 100 }),
            error => error instanceof RideCodexProbeCommandError && error.reason === 'timeout'
        );
        assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
        assert.equal(child.listenerCount('close'), 0);
        assert.equal(child.stdout.listenerCount('data'), 0);
    });

    await t.test('close during grace prevents force kill and no timer fires later', async () => {
        const child = new FakeSpawnedProcess();
        child.onKill = () => queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        const runner = new RideCodexBoundedExecRunner({
            platform: 'linux', spawn: () => child, terminationGraceMs: 10, terminationHardLimitMs: 40
        });
        await assert.rejects(runner.run('/opt/codex', [], { timeoutMs: 5, maxOutputBytes: 100 }));
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.deepEqual(child.signals, ['SIGTERM']);
    });

    await t.test('exit during grace settles without waiting for close or force kill', async () => {
        const child = new FakeSpawnedProcess();
        child.onKill = () => queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
        const runner = new RideCodexBoundedExecRunner({
            platform: 'linux', spawn: () => child, terminationGraceMs: 10, terminationHardLimitMs: 40
        });
        await assert.rejects(runner.run('/opt/codex', [], { timeoutMs: 5, maxOutputBytes: 100 }));
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.deepEqual(child.signals, ['SIGTERM']);
        assert.equal(child.listenerCount('exit'), 0);
    });

    await t.test('kill failure still waits for the hard termination deadline and settles once', async () => {
        const child = new FakeSpawnedProcess();
        child.kill = () => {
            throw new Error('kill failed with secret detail');
        };
        const runner = new RideCodexBoundedExecRunner({
            platform: 'linux', spawn: () => child, terminationGraceMs: 5, terminationHardLimitMs: 20
        });
        let settlements = 0;
        const started = Date.now();
        await runner.run('/opt/codex', [], { timeoutMs: 5, maxOutputBytes: 100 }).then(
            () => { settlements += 1; },
            () => { settlements += 1; }
        );
        assert.equal(settlements, 1);
        assert.ok(Date.now() - started >= 15);
        assert.equal(child.listenerCount('close'), 0);
    });

    await t.test('a misconfigured hard limit cannot preempt the force-kill grace step', async () => {
        const child = new FakeSpawnedProcess();
        child.onKill = signal => {
            if (signal === 'SIGKILL') {
                queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
            }
        };
        const runner = new RideCodexBoundedExecRunner({
            platform: 'linux', spawn: () => child, terminationGraceMs: 15, terminationHardLimitMs: 5
        });
        await assert.rejects(runner.run('/opt/codex', [], { timeoutMs: 5, maxOutputBytes: 100 }));
        assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    });

    await t.test('synchronous exit from kill cannot install late dangling timers', async () => {
        const child = new FakeSpawnedProcess();
        child.onKill = () => child.emit('exit', null, 'SIGTERM');
        const timeoutsBefore = process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length;
        const runner = new RideCodexBoundedExecRunner({
            platform: 'linux', spawn: () => child, terminationGraceMs: 1_000, terminationHardLimitMs: 2_000
        });
        await assert.rejects(runner.run('/opt/codex', [], { timeoutMs: 5, maxOutputBytes: 100 }));
        await new Promise(resolve => setImmediate(resolve));
        const timeoutsAfter = process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length;
        assert.equal(timeoutsAfter, timeoutsBefore);
        assert.deepEqual(child.signals, ['SIGTERM']);
    });
});

test('probe cancellation propagates through both probe stages and process termination', async t => {
    await t.test('resolver deadline cancels the active child before resolution rejects', async () => {
        const child = new FakeSpawnedProcess();
        child.onKill = () => queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        const runner = new RideCodexBoundedExecRunner({
            platform: 'win32',
            spawn: () => child,
            terminationGraceMs: 5,
            terminationHardLimitMs: 50
        });
        const fs = new VirtualFileSystem();
        fs.addFile(WINDOWS_NATIVE, peHeader('x64'));
        const resolver = new RideCodexRuntimeResolver({
            platform: 'win32',
            arch: 'x64',
            filesystem: fs,
            probe: new RideCodexRuntimeProbe({ runner, versionTimeoutMs: 1_000, helpTimeoutMs: 1_000 }),
            readEnvironment: () => ({ RIDE_CODEX_PATH: WINDOWS_NATIVE }),
            discoveryTimeoutMs: 20
        });

        await assert.rejects(resolver.resolve(), /deadline|timed out/i);

        assert.deepEqual(child.signals, [undefined]);
        assert.equal(child.listenerCount('close'), 0);
        assert.equal(child.listenerCount('error'), 0);
        assert.equal(child.stdout.listenerCount('data'), 0);
    });

    for (const stage of ['version', 'help'] as const) {
        await t.test(`external abort terminates the ${stage} child`, async () => {
            const controller = new AbortController();
            const children: FakeSpawnedProcess[] = [];
            let helpStarted: (() => void) | undefined;
            const helpGate = new Promise<void>(resolve => {
                helpStarted = resolve;
            });
            const runner = new RideCodexBoundedExecRunner({
                platform: 'linux',
                terminationGraceMs: 5,
                terminationHardLimitMs: 50,
                spawn: (_executable, args) => {
                    const child = new FakeSpawnedProcess();
                    children.push(child);
                    child.onKill = () => queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
                    if (args[0] === '--version' && stage === 'help') {
                        queueMicrotask(() => {
                            child.stdout.end('codex-cli 0.144.0\n');
                            child.emit('close', 0, null);
                        });
                    } else if (args[0] === 'app-server') {
                        helpStarted?.();
                    }
                    return child;
                }
            });
            const probe = new RideCodexRuntimeProbe({ runner, versionTimeoutMs: 1_000, helpTimeoutMs: 1_000 });
            const pending = probe.probe('/opt/codex', { signal: controller.signal, timeoutMs: 500 });
            if (stage === 'help') {
                await helpGate;
            } else {
                await new Promise(resolve => setImmediate(resolve));
            }

            controller.abort();
            await assert.rejects(pending, /abort/i);

            const activeChild = children[children.length - 1];
            assert.deepEqual(activeChild.signals, ['SIGTERM']);
            assert.equal(activeChild.listenerCount('close'), 0);
            assert.equal(activeChild.listenerCount('error'), 0);
        });
    }

    await t.test('abort, error, exit, and close races settle once without listeners or timers', async () => {
        const controller = new AbortController();
        const child = new FakeSpawnedProcess();
        child.onKill = () => queueMicrotask(() => {
            child.emit('error', new Error('OPENAI_API_KEY=race-secret'));
            child.emit('exit', null, 'SIGTERM');
            child.emit('close', null, 'SIGTERM');
        });
        const runner = new RideCodexBoundedExecRunner({
            platform: 'linux', spawn: () => child, terminationGraceMs: 10, terminationHardLimitMs: 40
        });
        let settlements = 0;
        const pending = runner.run('/opt/codex', ['--version'], {
            timeoutMs: 1_000,
            maxOutputBytes: 1_024,
            signal: controller.signal
        }).then(
            () => { settlements += 1; },
            () => { settlements += 1; }
        );

        controller.abort();
        await pending;
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(settlements, 1);
        assert.deepEqual(child.signals, ['SIGTERM']);
        assert.equal(child.listenerCount('error'), 0);
        assert.equal(child.listenerCount('exit'), 0);
        assert.equal(child.listenerCount('close'), 0);
        assert.equal(child.stdout.listenerCount('data'), 0);
    });
});

test('native executable headers prove PE, ELF, and Mach-O x64/arm64 targets before probing', async t => {
    const cases: ReadonlyArray<{
        name: string; platform: NodeJS.Platform; arch: 'x64' | 'arm64'; path: string; header: Uint8Array; target: string;
    }> = [
        { name: 'PE x64', platform: 'win32', arch: 'x64', path: 'C:\\bin\\codex.exe', header: peHeader('x64'), target: 'x86_64-pc-windows-msvc' },
        { name: 'PE arm64', platform: 'win32', arch: 'arm64', path: 'C:\\bin\\codex.exe', header: peHeader('arm64'), target: 'aarch64-pc-windows-msvc' },
        { name: 'ELF x64', platform: 'linux', arch: 'x64', path: '/opt/codex', header: elfHeader('x64'), target: 'x86_64-unknown-linux-musl' },
        { name: 'ELF arm64', platform: 'linux', arch: 'arm64', path: '/opt/codex', header: elfHeader('arm64'), target: 'aarch64-unknown-linux-musl' },
        { name: 'Mach-O x64', platform: 'darwin', arch: 'x64', path: '/opt/codex', header: machoHeader('x64'), target: 'x86_64-apple-darwin' },
        { name: 'Mach-O arm64', platform: 'darwin', arch: 'arm64', path: '/opt/codex', header: machoHeader('arm64'), target: 'aarch64-apple-darwin' },
        { name: 'Mach-O universal arm64', platform: 'darwin', arch: 'arm64', path: '/opt/codex', header: machoUniversalHeader(), target: 'aarch64-apple-darwin' }
    ];
    for (const entry of cases) {
        await t.test(entry.name, async () => {
            const fixture = createResolver({
                platform: entry.platform, arch: entry.arch, environment: { RIDE_CODEX_PATH: entry.path }
            });
            fixture.fs.addFile(entry.path, entry.header, true);
            const spec = await fixture.resolver.resolve();
            assertLaunchSpec(spec, { executable: entry.path, source: 'override', target: entry.target });
            assert.equal(fixture.fs.calls.some(call => /prefix:.*:65536$/i.test(call)), true);
        });
    }

    await t.test('runnable wrong-architecture binary is rejected before probe', async () => {
        const fixture = createResolver({ platform: 'win32', arch: 'x64', environment: { RIDE_CODEX_PATH: WINDOWS_NATIVE } });
        fixture.fs.addFile(WINDOWS_NATIVE, peHeader('arm64'), true);
        await assert.rejects(fixture.resolver.resolve(), /target|architecture/i);
        assert.equal(fixture.probe.calls.length, 0);
    });

    await t.test('malformed 32-bit Mach-O cannot claim a 64-bit target', async () => {
        const header = Buffer.from(machoHeader('x64'));
        header.writeUInt32LE(0xfeedface, 0);
        const fixture = createResolver({
            platform: 'darwin', arch: 'x64', environment: { RIDE_CODEX_PATH: '/opt/codex' }
        });
        fixture.fs.addFile('/opt/codex', header, true);
        await assert.rejects(fixture.resolver.resolve(), /native|recognized|architecture/i);
        assert.equal(fixture.probe.calls.length, 0);
    });
});

class RealMappedPosixFileSystem implements RideCodexRuntimeFileSystem {
    constructor(readonly root: string) { }

    toNative(path: string): string {
        assert.ok(path === '/fixture' || path.startsWith('/fixture/'));
        return nativeJoin(this.root, ...path.slice('/fixture'.length).split('/').filter(Boolean));
    }

    async lstat(path: string): Promise<RideCodexRuntimeFileStat> {
        return realFs.lstat(this.toNative(path));
    }

    async readTextFile(path: string): Promise<string> {
        return realFs.readFile(this.toNative(path), 'utf8');
    }

    async readFilePrefix(path: string, maxBytes: number): Promise<Uint8Array> {
        const handle = await realFs.open(this.toNative(path), 'r');
        try {
            const buffer = Buffer.alloc(maxBytes);
            const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
            return buffer.subarray(0, bytesRead);
        } finally {
            await handle.close();
        }
    }

    async readLink(path: string): Promise<string> {
        const target = await realFs.readlink(this.toNative(path));
        if (!target.startsWith(nativeSeparator)) {
            return target.split(nativeSeparator).join('/');
        }
        const relative = nativeRelative(this.root, target);
        return `/fixture/${relative.split(nativeSeparator).join('/')}`;
    }

    async realpath(path: string): Promise<string> {
        const canonical = await realFs.realpath(this.toNative(path));
        const relative = nativeRelative(this.root, canonical);
        return relative ? `/fixture/${relative.split(nativeSeparator).join('/')}` : '/fixture';
    }

    async isExecutable(path: string): Promise<boolean> {
        try {
            await realFs.access(this.toNative(path), fsConstants.X_OK);
            return true;
        } catch {
            return false;
        }
    }
}

test('resolves a real POSIX npm bin symlink only through a validated package and native optional package', async () => {
    const root = await realFs.mkdtemp(nativeJoin(tmpdir(), 'ride-codex-posix-'));
    const filesystem = new RealMappedPosixFileSystem(root);
    const link = '/fixture/bin/codex';
    const packageRoot = '/fixture/lib/node_modules/@openai/codex';
    const script = `${packageRoot}/bin/codex.js`;
    const nativeRoot = '/fixture/lib/node_modules/@openai/codex-linux-x64';
    const target = 'x86_64-unknown-linux-musl';
    const manifest = `${nativeRoot}/vendor/${target}/codex-package.json`;
    const executable = `${nativeRoot}/vendor/${target}/bin/codex`;
    try {
        for (const directory of [
            nativeDirname(filesystem.toNative(link)), nativeDirname(filesystem.toNative(script)),
            nativeDirname(filesystem.toNative(manifest)), nativeDirname(filesystem.toNative(executable))
        ]) {
            await realFs.mkdir(directory, { recursive: true });
        }
        await realFs.writeFile(filesystem.toNative(script), '#!/usr/bin/env node\n');
        await realFs.writeFile(filesystem.toNative(`${packageRoot}/package.json`), JSON.stringify({
            name: '@openai/codex', version: '0.144.0', bin: { codex: 'bin/codex.js' }
        }));
        await realFs.writeFile(filesystem.toNative(manifest), JSON.stringify({
            layoutVersion: 1, version: '0.144.0', target, variant: 'codex', entrypoint: 'bin/codex'
        }));
        await realFs.writeFile(filesystem.toNative(executable), elfHeader('x64'));
        await realFs.chmod(filesystem.toNative(executable), 0o755);
        const relativeTarget = nativeRelative(nativeDirname(filesystem.toNative(link)), filesystem.toNative(script));
        await realFs.symlink(relativeTarget, filesystem.toNative(link), 'file');

        const probe = new FakeProbe();
        const resolver = new RideCodexRuntimeResolver({
            platform: 'linux', arch: 'x64', filesystem, probe,
            readEnvironment: () => ({ RIDE_CODEX_PATH: link })
        });
        const spec = await resolver.resolve();
        assertLaunchSpec(spec, { executable, source: 'override', target });
        assert.deepEqual(probe.calls.map(call => call.executable), [executable]);
        assert.equal(probe.calls.some(call => /\.js$|\/bin\/codex$/.test(call.executable) && call.executable === link), false);
    } finally {
        await realFs.rm(root, { recursive: true, force: true });
    }
});

test('POSIX npm resolution rejects excessive symlink hops and arbitrary scripts without probing', async t => {
    await t.test('hop limit', async () => {
        const fs = new VirtualFileSystem();
        const entry = '/usr/local/bin/codex';
        for (let index = 0; index < 10; index += 1) {
            fs.addSymlink(index === 0 ? entry : `/links/${index}`, `/links/${index + 1}`);
        }
        fs.addFile('/links/10', '#!/usr/bin/env node\n');
        const probe = new FakeProbe();
        const resolver = new RideCodexRuntimeResolver({
            platform: 'linux', arch: 'x64', filesystem: fs, probe,
            readEnvironment: () => ({ RIDE_CODEX_PATH: entry })
        });
        await assert.rejects(resolver.resolve(), /symlink|hop|launcher/i);
        assert.equal(probe.calls.length, 0);
    });

    await t.test('symlink to an arbitrary JavaScript file', async () => {
        const fs = new VirtualFileSystem();
        fs.addSymlink('/usr/local/bin/codex', '/tmp/codex.js');
        fs.addFile('/tmp/codex.js', '#!/usr/bin/env node\n');
        const probe = new FakeProbe();
        const resolver = new RideCodexRuntimeResolver({
            platform: 'linux', arch: 'x64', filesystem: fs, probe,
            readEnvironment: () => ({ RIDE_CODEX_PATH: '/usr/local/bin/codex' })
        });
        await assert.rejects(resolver.resolve(), /package|launcher|script/i);
        assert.equal(probe.calls.length, 0);
    });
});

test('wrapper and manifest reads are max-plus-one bounded, environment lookup is platform-correct, and PATH duplicates do not spend budget', async () => {
    const wrapper = 'C:\\npm\\codex.cmd';
    const fixture = createResolver({ environment: { RIDE_CODEX_PATH: wrapper } });
    addWindowsNpmLayout(fixture.fs, wrapper);
    await fixture.resolver.resolve();
    assert.equal(fixture.fs.calls.some(call => call.startsWith('read:')), false);
    assert.equal(fixture.fs.calls.includes(`prefix:${wrapper}:65537`), true);
    assert.equal(fixture.fs.calls.some(call => /codex-package\.json:16385$/i.test(call)), true);

    assert.equal(discoverDefaultCodexSystemCandidates({ Path: '/wrong' }, 'linux').candidates.length, 0);
    assert.ok(discoverDefaultCodexSystemCandidates({ Path: 'C:\\tools' }, 'win32').candidates.length > 0);

    const system = '/opt/system/codex';
    const posix = createResolver({
        platform: 'linux', arch: 'x64', environment: { ride_codex_path: '/wrong/codex' }, system: [system]
    });
    posix.fs.addFile(system, elfHeader('x64'));
    assertLaunchSpec(await posix.resolver.resolve(), {
        executable: system, source: 'system', target: 'x86_64-unknown-linux-musl'
    });

    const duplicated = Array.from({ length: 700 }, () => '/opt/repeated');
    const discovery = discoverDefaultCodexSystemCandidates({ PATH: [...duplicated, '/opt/late'].join(':') }, 'linux');
    assert.equal(discovery.scannedDirectories, 2);
    assert.ok(discovery.candidates.includes('/opt/late/codex'));
    assert.equal(discovery.truncated, false);
});
