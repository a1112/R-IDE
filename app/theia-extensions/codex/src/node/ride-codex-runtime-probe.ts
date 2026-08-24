/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { spawn as nodeSpawn } from 'node:child_process';
import compatibility from '../common/codex-app-server-compatibility.json';

export type RideCodexProbeFailureReason = 'timeout' | 'aborted' | 'max-output' | 'not-found' | 'spawn' | 'exit' | 'signal';

export class RideCodexProbeCommandError extends Error {
    constructor(readonly reason: RideCodexProbeFailureReason, _unsafeDetail?: string) {
        super(commandFailureMessage(reason));
        this.name = 'RideCodexProbeCommandError';
    }
}

export interface RideCodexProbeCommandLimits {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly signal?: AbortSignal;
}

export interface RideCodexProbeCommandResult {
    readonly stdout: string;
    readonly stderr: string;
}

export interface RideCodexProbeCommandRunner {
    run(
        executable: string,
        args: readonly string[],
        limits: RideCodexProbeCommandLimits
    ): Promise<RideCodexProbeCommandResult>;
}

interface RideCodexReadableStream {
    on(event: 'data', listener: (chunk: Buffer | string) => void): this;
    once(event: 'error', listener: (error: Error) => void): this;
    removeListener(event: 'data', listener: (chunk: Buffer | string) => void): this;
    removeListener(event: 'error', listener: (error: Error) => void): this;
}

export interface RideCodexSpawnedProcess {
    readonly stdout: RideCodexReadableStream;
    readonly stderr: RideCodexReadableStream;
    once(event: 'error', listener: (error: NodeJS.ErrnoException) => void): this;
    once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
    once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
    removeListener(event: 'error', listener: (error: NodeJS.ErrnoException) => void): this;
    removeListener(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
    removeListener(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
    kill(signal?: NodeJS.Signals | number): boolean;
}

export interface RideCodexSpawnOptions {
    readonly shell: false;
    readonly windowsHide: true;
    readonly stdio: readonly ['ignore', 'pipe', 'pipe'];
    readonly env: Readonly<Record<string, string>>;
}

export type RideCodexSpawn = (
    executable: string,
    args: readonly string[],
    options: RideCodexSpawnOptions
) => RideCodexSpawnedProcess;

export interface RideCodexBoundedExecRunnerOptions {
    readonly spawn?: RideCodexSpawn;
    readonly platform?: NodeJS.Platform;
    readonly readEnvironment?: () => Readonly<Record<string, string | undefined>>;
    readonly terminationGraceMs?: number;
    readonly terminationHardLimitMs?: number;
}

export class RideCodexBoundedExecRunner implements RideCodexProbeCommandRunner {
    private readonly spawn: RideCodexSpawn;
    private readonly platform: NodeJS.Platform;
    private readonly readEnvironment: () => Readonly<Record<string, string | undefined>>;
    private readonly terminationGraceMs: number;
    private readonly terminationHardLimitMs: number;

    constructor(options: RideCodexBoundedExecRunnerOptions = {}) {
        this.spawn = options.spawn ?? (nodeSpawn as unknown as RideCodexSpawn);
        this.platform = options.platform ?? process.platform;
        this.readEnvironment = options.readEnvironment ?? (() => process.env);
        this.terminationGraceMs = positiveDuration(options.terminationGraceMs, 100);
        this.terminationHardLimitMs = Math.max(
            positiveDuration(options.terminationHardLimitMs, 500),
            this.terminationGraceMs + 1
        );
    }

    run(
        executable: string,
        args: readonly string[],
        limits: RideCodexProbeCommandLimits
    ): Promise<RideCodexProbeCommandResult> {
        if (!Number.isFinite(limits.timeoutMs) || limits.timeoutMs <= 0
            || !Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes <= 0) {
            return Promise.reject(new RideCodexProbeCommandError('spawn'));
        }
        if (limits.signal?.aborted) {
            return Promise.reject(new RideCodexProbeCommandError('aborted'));
        }

        return new Promise<RideCodexProbeCommandResult>((resolve, reject) => {
            let child: RideCodexSpawnedProcess;
            try {
                child = this.spawn(executable, args, {
                    shell: false,
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: createProbeEnvironment(this.readEnvironment(), this.platform)
                });
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                reject(new RideCodexProbeCommandError(code === 'ENOENT' ? 'not-found' : 'spawn'));
                return;
            }

            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let outputBytes = 0;
            let settled = false;
            let terminalReason: RideCodexProbeFailureReason | undefined;
            let operationTimer: ReturnType<typeof setTimeout> | undefined;
            let terminationGraceTimer: ReturnType<typeof setTimeout> | undefined;
            let terminationHardTimer: ReturnType<typeof setTimeout> | undefined;

            const cleanup = (): void => {
                if (operationTimer) {
                    clearTimeout(operationTimer);
                }
                if (terminationGraceTimer) {
                    clearTimeout(terminationGraceTimer);
                }
                if (terminationHardTimer) {
                    clearTimeout(terminationHardTimer);
                }
                child.stdout.removeListener('data', onStdout);
                child.stderr.removeListener('data', onStderr);
                child.stdout.removeListener('error', onStreamError);
                child.stderr.removeListener('error', onStreamError);
                child.removeListener('error', onError);
                child.removeListener('close', onClose);
                child.removeListener('exit', onExit);
                limits.signal?.removeEventListener('abort', onAbort);
            };
            const rejectOnce = (reason: RideCodexProbeFailureReason): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                reject(new RideCodexProbeCommandError(reason));
            };
            const killChild = (force: boolean): void => {
                try {
                    if (this.platform === 'win32') {
                        child.kill();
                    } else {
                        child.kill(force ? 'SIGKILL' : 'SIGTERM');
                    }
                } catch {
                    // A failed kill remains bounded by the hard termination timer.
                }
            };
            const terminate = (reason: RideCodexProbeFailureReason): void => {
                if (settled || terminalReason) {
                    return;
                }
                terminalReason = reason;
                if (operationTimer) {
                    clearTimeout(operationTimer);
                }
                terminationGraceTimer = setTimeout(() => {
                    if (!settled) {
                        killChild(true);
                    }
                }, this.terminationGraceMs);
                terminationHardTimer = setTimeout(() => rejectOnce(reason), this.terminationHardLimitMs);
                killChild(false);
            };
            const collect = (destination: Buffer[], chunk: Buffer | string): void => {
                if (settled) {
                    return;
                }
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                outputBytes += buffer.length;
                if (outputBytes > limits.maxOutputBytes) {
                    killChild(true);
                    rejectOnce('max-output');
                    return;
                }
                destination.push(buffer);
            };
            const onStdout = (chunk: Buffer | string): void => collect(stdout, chunk);
            const onStderr = (chunk: Buffer | string): void => collect(stderr, chunk);
            const onStreamError = (): void => {
                killChild(true);
                rejectOnce('spawn');
            };
            const onAbort = (): void => terminate('aborted');
            const onError = (error: NodeJS.ErrnoException): void => {
                if (!terminalReason) {
                    rejectOnce(error.code === 'ENOENT' ? 'not-found' : 'spawn');
                }
            };
            const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
                if (settled) {
                    return;
                }
                if (terminalReason) {
                    rejectOnce(terminalReason);
                    return;
                }
                if (signal) {
                    rejectOnce('signal');
                    return;
                }
                if (code !== 0) {
                    rejectOnce('exit');
                    return;
                }
                settled = true;
                cleanup();
                resolve({
                    stdout: Buffer.concat(stdout).toString('utf8'),
                    stderr: Buffer.concat(stderr).toString('utf8')
                });
            };
            const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
                if (terminalReason) {
                    rejectOnce(terminalReason);
                    return;
                }
                if (signal) {
                    rejectOnce('signal');
                    return;
                }
                if (code !== 0) {
                    rejectOnce('exit');
                }
            };

            child.stdout.on('data', onStdout);
            child.stderr.on('data', onStderr);
            child.stdout.once('error', onStreamError);
            child.stderr.once('error', onStreamError);
            child.once('error', onError);
            child.once('close', onClose);
            child.once('exit', onExit);
            operationTimer = setTimeout(() => terminate('timeout'), limits.timeoutMs);
            limits.signal?.addEventListener('abort', onAbort, { once: true });
            if (limits.signal?.aborted) {
                onAbort();
            }
        });
    }
}

const MAX_PROBE_ENVIRONMENT_BYTES = 16 * 1024;
const MAX_PROBE_ENVIRONMENT_VALUE_BYTES = 4 * 1024;
const PROBE_ENVIRONMENT_KEYS = Object.freeze([
    'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR',
    'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'
]);
const SECRET_ENVIRONMENT_KEY = /(?:API.?KEY|TOKEN|AUTHORIZATION|SECRET|PASSWORD|CREDENTIAL|RIDE_CODEX_PATH|CODEX_HOME)/i;

function createProbeEnvironment(
    environment: Readonly<Record<string, string | undefined>>,
    platform: NodeJS.Platform
): Readonly<Record<string, string>> {
    const safe: Record<string, string> = {};
    let bytes = 0;
    for (const canonicalKey of PROBE_ENVIRONMENT_KEYS) {
        const actualKey = platform === 'win32'
            ? Object.keys(environment).find(key => key.toLowerCase() === canonicalKey.toLowerCase())
            : canonicalKey in environment ? canonicalKey : undefined;
        if (!actualKey || SECRET_ENVIRONMENT_KEY.test(actualKey)) {
            continue;
        }
        const value = environment[actualKey];
        if (typeof value !== 'string' || value.includes('\0')) {
            continue;
        }
        const entryBytes = Buffer.byteLength(canonicalKey) + Buffer.byteLength(value);
        if (entryBytes > MAX_PROBE_ENVIRONMENT_VALUE_BYTES || bytes + entryBytes > MAX_PROBE_ENVIRONMENT_BYTES) {
            continue;
        }
        safe[canonicalKey] = value;
        bytes += entryBytes;
    }
    return Object.freeze(safe);
}

function positiveDuration(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

export interface RideCodexRuntimeProbeResult {
    readonly version: string;
}

export interface RideCodexRuntimeProbeRequest {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}

export interface RideCodexRuntimeProbeLike {
    probe(executable: string, request?: RideCodexRuntimeProbeRequest): Promise<RideCodexRuntimeProbeResult>;
}

export interface RideCodexRuntimeProbeOptions {
    readonly runner?: RideCodexProbeCommandRunner;
    readonly versionTimeoutMs?: number;
    readonly helpTimeoutMs?: number;
    readonly maxOutputBytes?: number;
}

const DEFAULT_VERSION_TIMEOUT_MS = 3_000;
const DEFAULT_HELP_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export class RideCodexRuntimeProbe implements RideCodexRuntimeProbeLike {
    private readonly runner: RideCodexProbeCommandRunner;
    private readonly versionTimeoutMs: number;
    private readonly helpTimeoutMs: number;
    private readonly maxOutputBytes: number;

    constructor(options: RideCodexRuntimeProbeOptions = {}) {
        this.runner = options.runner ?? new RideCodexBoundedExecRunner();
        this.versionTimeoutMs = options.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
        this.helpTimeoutMs = options.helpTimeoutMs ?? DEFAULT_HELP_TIMEOUT_MS;
        this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    }

    async probe(executable: string, request: RideCodexRuntimeProbeRequest = {}): Promise<RideCodexRuntimeProbeResult> {
        const expiresAt = Number.isFinite(request.timeoutMs) && request.timeoutMs! > 0
            ? Date.now() + request.timeoutMs!
            : Number.POSITIVE_INFINITY;
        const versionOutput = await this.runProbe(
            executable,
            ['--version'],
            boundedStageTimeout(this.versionTimeoutMs, expiresAt),
            request.signal,
            'Codex CLI version probe failed'
        );
        const version = parseCodexVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
        if (!version) {
            throw new Error('Codex CLI version output is invalid. Expected "codex-cli 0.144.0".');
        }
        if (!isCompatibleVersion(version)) {
            throw new Error(
                `Codex CLI version is incompatible; R-IDE requires ${compatibility.minimumCompatibleCliVersion}.`
            );
        }

        const helpOutput = await this.runProbe(
            executable,
            ['app-server', '--help'],
            boundedStageTimeout(this.helpTimeoutMs, expiresAt),
            request.signal,
            'Codex App Server probe failed'
        );
        const help = `${helpOutput.stdout}\n${helpOutput.stderr}`;
        if (!/\bUsage:\s+codex\s+app-server(?:\s|\[|$)/i.test(help)) {
            throw new Error('Codex App Server command is unavailable or returned unrecognized help.');
        }
        return Object.freeze({ version });
    }

    private async runProbe(
        executable: string,
        args: readonly string[],
        timeoutMs: number,
        signal: AbortSignal | undefined,
        label: string
    ): Promise<RideCodexProbeCommandResult> {
        try {
            const limits: RideCodexProbeCommandLimits = {
                timeoutMs,
                maxOutputBytes: this.maxOutputBytes,
                ...(signal ? { signal } : {})
            };
            return await this.runner.run(executable, args, limits);
        } catch (error) {
            const reason = error instanceof RideCodexProbeCommandError ? ` (${error.reason})` : '';
            throw new Error(`${label}${reason}.`);
        }
    }
}

function boundedStageTimeout(stageTimeoutMs: number, expiresAt: number): number {
    if (!Number.isFinite(expiresAt)) {
        return stageTimeoutMs;
    }
    return Math.max(1, Math.min(stageTimeoutMs, expiresAt - Date.now()));
}

function parseCodexVersion(output: string): string | undefined {
    const match = /(?:^|\r?\n)\s*codex-cli\s+(\d+\.\d+\.\d+)\s*(?:\r?\n|$)/.exec(output);
    return match?.[1];
}

function isCompatibleVersion(version: string): boolean {
    return compareVersions(version, compatibility.minimumCompatibleCliVersion) >= 0
        && compareVersions(version, compatibility.maximumCompatibleCliVersion) <= 0;
}

function compareVersions(left: string, right: string): number {
    const leftParts = left.split('.').map(Number);
    const rightParts = right.split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
        const difference = leftParts[index] - rightParts[index];
        if (difference !== 0) {
            return difference;
        }
    }
    return 0;
}

function commandFailureMessage(reason: RideCodexProbeFailureReason): string {
    switch (reason) {
        case 'timeout': return 'Codex probe timed out.';
        case 'aborted': return 'Codex probe was aborted.';
        case 'max-output': return 'Codex probe exceeded the output limit.';
        case 'not-found': return 'Codex executable was not found.';
        case 'exit': return 'Codex probe exited unsuccessfully.';
        case 'signal': return 'Codex probe was terminated by a signal.';
        default: return 'Codex probe could not be started.';
    }
}
