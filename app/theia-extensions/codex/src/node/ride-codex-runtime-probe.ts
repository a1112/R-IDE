/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { spawn as nodeSpawn } from 'node:child_process';
import compatibility from '../common/codex-app-server-compatibility.json';

export type RideCodexProbeFailureReason = 'timeout' | 'max-output' | 'not-found' | 'spawn' | 'exit' | 'signal';

export class RideCodexProbeCommandError extends Error {
    constructor(readonly reason: RideCodexProbeFailureReason, _unsafeDetail?: string) {
        super(commandFailureMessage(reason));
        this.name = 'RideCodexProbeCommandError';
    }
}

export interface RideCodexProbeCommandLimits {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
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
    removeListener(event: 'error', listener: (error: NodeJS.ErrnoException) => void): this;
    removeListener(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
    kill(): boolean;
}

export interface RideCodexSpawnOptions {
    readonly shell: false;
    readonly windowsHide: true;
    readonly stdio: readonly ['ignore', 'pipe', 'pipe'];
}

export type RideCodexSpawn = (
    executable: string,
    args: readonly string[],
    options: RideCodexSpawnOptions
) => RideCodexSpawnedProcess;

export interface RideCodexBoundedExecRunnerOptions {
    readonly spawn?: RideCodexSpawn;
}

export class RideCodexBoundedExecRunner implements RideCodexProbeCommandRunner {
    private readonly spawn: RideCodexSpawn;

    constructor(options: RideCodexBoundedExecRunnerOptions = {}) {
        this.spawn = options.spawn ?? (nodeSpawn as unknown as RideCodexSpawn);
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

        return new Promise<RideCodexProbeCommandResult>((resolve, reject) => {
            let child: RideCodexSpawnedProcess;
            try {
                child = this.spawn(executable, args, {
                    shell: false,
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe']
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
            let timer: ReturnType<typeof setTimeout>;

            const cleanup = (): void => {
                clearTimeout(timer);
                child.stdout.removeListener('data', onStdout);
                child.stderr.removeListener('data', onStderr);
                child.stdout.removeListener('error', onStreamError);
                child.stderr.removeListener('error', onStreamError);
                child.removeListener('error', onError);
                child.removeListener('close', onClose);
            };
            const fail = (reason: RideCodexProbeFailureReason, kill = false): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                if (kill) {
                    try {
                        child.kill();
                    } catch {
                        // The process may already have exited.
                    }
                }
                reject(new RideCodexProbeCommandError(reason));
            };
            const collect = (destination: Buffer[], chunk: Buffer | string): void => {
                if (settled) {
                    return;
                }
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                outputBytes += buffer.length;
                if (outputBytes > limits.maxOutputBytes) {
                    fail('max-output', true);
                    return;
                }
                destination.push(buffer);
            };
            const onStdout = (chunk: Buffer | string): void => collect(stdout, chunk);
            const onStderr = (chunk: Buffer | string): void => collect(stderr, chunk);
            const onStreamError = (): void => fail('spawn', true);
            const onError = (error: NodeJS.ErrnoException): void => {
                fail(error.code === 'ENOENT' ? 'not-found' : 'spawn');
            };
            const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
                if (settled) {
                    return;
                }
                if (signal) {
                    fail('signal');
                    return;
                }
                if (code !== 0) {
                    fail('exit');
                    return;
                }
                settled = true;
                cleanup();
                resolve({
                    stdout: Buffer.concat(stdout).toString('utf8'),
                    stderr: Buffer.concat(stderr).toString('utf8')
                });
            };

            child.stdout.on('data', onStdout);
            child.stderr.on('data', onStderr);
            child.stdout.once('error', onStreamError);
            child.stderr.once('error', onStreamError);
            child.once('error', onError);
            child.once('close', onClose);
            timer = setTimeout(() => fail('timeout', true), limits.timeoutMs);
        });
    }
}

export interface RideCodexRuntimeProbeResult {
    readonly version: string;
    readonly target: string;
}

export interface RideCodexRuntimeProbeLike {
    probe(executable: string, target: string): Promise<RideCodexRuntimeProbeResult>;
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

    async probe(executable: string, target: string): Promise<RideCodexRuntimeProbeResult> {
        const versionOutput = await this.runProbe(
            executable,
            ['--version'],
            this.versionTimeoutMs,
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
            this.helpTimeoutMs,
            'Codex App Server probe failed'
        );
        const help = `${helpOutput.stdout}\n${helpOutput.stderr}`;
        if (!/\bUsage:\s+codex\s+app-server(?:\s|\[|$)/i.test(help)) {
            throw new Error('Codex App Server command is unavailable or returned unrecognized help.');
        }
        return Object.freeze({ version, target });
    }

    private async runProbe(
        executable: string,
        args: readonly string[],
        timeoutMs: number,
        label: string
    ): Promise<RideCodexProbeCommandResult> {
        try {
            return await this.runner.run(executable, args, {
                timeoutMs,
                maxOutputBytes: this.maxOutputBytes
            });
        } catch (error) {
            const reason = error instanceof RideCodexProbeCommandError ? ` (${error.reason})` : '';
            throw new Error(`${label}${reason}.`);
        }
    }
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
        case 'max-output': return 'Codex probe exceeded the output limit.';
        case 'not-found': return 'Codex executable was not found.';
        case 'exit': return 'Codex probe exited unsuccessfully.';
        case 'signal': return 'Codex probe was terminated by a signal.';
        default: return 'Codex probe could not be started.';
    }
}
