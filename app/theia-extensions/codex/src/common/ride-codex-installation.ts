/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export type InstallState =
    | 'awaiting-consent'
    | 'downloading'
    | 'verifying'
    | 'activating'
    | 'ready'
    | 'rolled-back'
    | 'failed';

export type InstallTarget =
    | 'x86_64-pc-windows-msvc'
    | 'aarch64-pc-windows-msvc'
    | 'x86_64-apple-darwin'
    | 'aarch64-apple-darwin'
    | 'x86_64-unknown-linux-musl'
    | 'aarch64-unknown-linux-musl';

export type InstallSource = 'official-npm-registry';
export type InstallRollbackPolicy = 'retain-new-and-previous-valid';

export interface InstallPresentation {
    readonly source: InstallSource;
    readonly version: string;
    readonly target: InstallTarget;
    readonly urlOrigin: string;
    readonly installRoot: string;
    readonly requiredSpaceBytes: number;
    readonly rollbackPolicy: InstallRollbackPolicy;
    readonly manifestDigest: string;
}

export interface InstallProgress {
    readonly state: InstallState;
    readonly version: string;
    readonly target: InstallTarget;
    readonly sequence: number;
}

export interface InstallDiagnostic {
    readonly code: string;
    readonly message: string;
}

export interface InstallResult {
    readonly state: 'ready';
    readonly version: string;
    readonly target: InstallTarget;
    readonly executable: string;
    readonly previousVersion?: string;
    readonly diagnostics: readonly InstallDiagnostic[];
}

const PRESENTATION_KEYS = Object.freeze([
    'installRoot', 'manifestDigest', 'requiredSpaceBytes', 'rollbackPolicy',
    'source', 'target', 'urlOrigin', 'version'
].sort());
const INSTALL_TARGETS = new Set<string>([
    'x86_64-pc-windows-msvc',
    'aarch64-pc-windows-msvc',
    'x86_64-apple-darwin',
    'aarch64-apple-darwin',
    'x86_64-unknown-linux-musl',
    'aarch64-unknown-linux-musl'
]);
const MAX_TEXT_BYTES = 4 * 1024;
const MAX_DIAGNOSTIC_BYTES = 160;
const UTF8_ENCODER = new TextEncoder();

export function createRideCodexInstallPresentation(candidate: InstallPresentation): InstallPresentation {
    const record = requirePlainDataRecord(candidate, PRESENTATION_KEYS);
    const version = requireBoundedText(record.version, 'version');
    const installRoot = requireBoundedText(record.installRoot, 'install root');
    const urlOrigin = requireBoundedText(record.urlOrigin, 'URL origin');
    const manifestDigest = requireBoundedText(record.manifestDigest, 'manifest digest');
    if (record.source !== 'official-npm-registry'
        || record.rollbackPolicy !== 'retain-new-and-previous-valid'
        || typeof record.target !== 'string'
        || !INSTALL_TARGETS.has(record.target)
        || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
        || !isAbsolutePortablePath(installRoot)
        || !Number.isSafeInteger(record.requiredSpaceBytes)
        || (record.requiredSpaceBytes as number) <= 0
        || !/^sha256-[a-f0-9]{64}$/.test(manifestDigest)) {
        throw new Error('Codex install presentation is invalid.');
    }
    let parsedOrigin: URL;
    try {
        parsedOrigin = new URL(urlOrigin);
    } catch {
        throw new Error('Codex install presentation URL origin is invalid.');
    }
    if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== urlOrigin
        || parsedOrigin.origin !== 'https://registry.npmjs.org'
        || parsedOrigin.username || parsedOrigin.password || parsedOrigin.pathname !== '/') {
        throw new Error('Codex install presentation URL origin is invalid.');
    }
    return Object.freeze({
        source: 'official-npm-registry',
        version,
        target: record.target as InstallTarget,
        urlOrigin,
        installRoot,
        requiredSpaceBytes: record.requiredSpaceBytes as number,
        rollbackPolicy: 'retain-new-and-previous-valid',
        manifestDigest
    });
}

export function createRideCodexInstallProgress(
    state: InstallState,
    presentation: InstallPresentation,
    sequence: number
): InstallProgress {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new Error('Codex install progress sequence is invalid.');
    }
    return Object.freeze({ state, version: presentation.version, target: presentation.target, sequence });
}

export function createRideCodexInstallDiagnostic(code: string, message: string): InstallDiagnostic {
    const safeCode = boundedDiagnosticText(code, 'install-failed').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    return Object.freeze({
        code: safeCode || 'install-failed',
        message: boundedDiagnosticText(message, 'Codex managed runtime installation failed safely.')
    });
}

function boundedDiagnosticText(value: string, fallback: string): string {
    if (typeof value !== 'string') {
        return fallback;
    }
    const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!sanitized) {
        return fallback;
    }
    let bounded = sanitized.slice(0, MAX_DIAGNOSTIC_BYTES);
    while (UTF8_ENCODER.encode(bounded).length > MAX_DIAGNOSTIC_BYTES) {
        bounded = bounded.slice(0, -1);
    }
    return bounded.trim() || fallback;
}

function requirePlainDataRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
    if (typeof value !== 'object' || !value || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error('Codex install presentation must be a plain data object.');
    }
    const keys = Object.keys(value).sort();
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
        throw new Error('Codex install presentation has an invalid shape.');
    }
    const record: Record<string, unknown> = {};
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            throw new Error('Codex install presentation contains an unsafe property.');
        }
        record[key] = descriptor.value;
    }
    return record;
}

function requireBoundedText(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')
        || UTF8_ENCODER.encode(value).length > MAX_TEXT_BYTES) {
        throw new Error(`Codex install presentation ${field} is invalid.`);
    }
    return value;
}

function isAbsolutePortablePath(value: string): boolean {
    return (value.startsWith('/') && !value.startsWith('//')) || /^[A-Za-z]:[\\/]/.test(value);
}
