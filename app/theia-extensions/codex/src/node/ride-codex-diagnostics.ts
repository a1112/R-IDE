/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export type RideCodexAppServerDiagnosticCode =
    | 'early-exit'
    | 'handshake-timeout'
    | 'protocol-error'
    | 'spawn-failed'
    | 'unexpected-exit'
    | 'unsafe-approval-exit'
    | 'circuit-open'
    | 'shutdown-forced'
    | 'shutdown-timeout';

export interface RideCodexAppServerDiagnosticEntry {
    readonly code: RideCodexAppServerDiagnosticCode;
    readonly message: string;
    readonly truncated: boolean;
}

export interface RideCodexAppServerDiagnosticSnapshot {
    readonly entries: readonly RideCodexAppServerDiagnosticEntry[];
    readonly entriesTruncated: boolean;
    readonly stderr: {
        readonly lines: readonly string[];
        readonly bytes: number;
        readonly truncated: boolean;
    };
}

export interface RideCodexAppServerDiagnosticsOptions {
    readonly maxEntries?: number;
    readonly maxEntryBytes?: number;
    readonly maxStderrLines?: number;
    readonly maxStderrBytes?: number;
    readonly maxLineBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_ENTRY_BYTES = 160;
const DEFAULT_MAX_STDERR_LINES = 64;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_MAX_LINE_BYTES = 512;

const DEFAULT_MESSAGE_BY_CODE: Readonly<Record<RideCodexAppServerDiagnosticCode, string>> = Object.freeze({
    'early-exit': 'Codex App Server exited before initialization completed.',
    'handshake-timeout': 'Codex App Server initialization timed out.',
    'protocol-error': 'Codex App Server returned invalid protocol data.',
    'spawn-failed': 'Codex App Server could not be started.',
    'unexpected-exit': 'Codex App Server exited unexpectedly.',
    'unsafe-approval-exit': 'Codex App Server exited while an unsafe approval was pending.',
    'circuit-open': 'Codex App Server restart circuit is open.',
    'shutdown-forced': 'Codex App Server did not close gracefully and its owned process was terminated.',
    'shutdown-timeout': 'Codex App Server owned process did not confirm exit within the shutdown bound.'
});

export class RideCodexAppServerDiagnostics {
    readonly #entries: RideCodexAppServerDiagnosticEntry[] = [];
    readonly #stderrLines: string[] = [];
    readonly #maxEntries: number;
    readonly #maxEntryBytes: number;
    readonly #maxStderrLines: number;
    readonly #maxStderrBytes: number;
    readonly #maxLineBytes: number;
    #entriesTruncated = false;
    #stderrTruncated = false;
    #stderrBytes = 0;
    #pendingLine = Buffer.alloc(0);
    #pendingLineTruncated = false;

    constructor(options: RideCodexAppServerDiagnosticsOptions = {}) {
        this.#maxEntries = safeLimit(options.maxEntries, DEFAULT_MAX_ENTRIES, 1, 'diagnostic entries');
        this.#maxEntryBytes = safeLimit(options.maxEntryBytes, DEFAULT_MAX_ENTRY_BYTES, 16, 'diagnostic entry bytes');
        this.#maxStderrLines = safeLimit(options.maxStderrLines, DEFAULT_MAX_STDERR_LINES, 1, 'stderr lines');
        this.#maxStderrBytes = safeLimit(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES, 16, 'stderr bytes');
        this.#maxLineBytes = safeLimit(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES, 16, 'stderr line bytes');
    }

    record(code: RideCodexAppServerDiagnosticCode, detail?: unknown): void {
        const raw = typeof detail === 'string' && detail.trim().length > 0
            ? detail
            : DEFAULT_MESSAGE_BY_CODE[code];
        const input = boundUtf8(raw, this.#maxEntryBytes);
        const redacted = input.truncated ? '[truncated] <redacted>' : redactUntrustedText(input.value);
        const bounded = boundUtf8(redacted, this.#maxEntryBytes);
        this.#entries.push(Object.freeze({
            code,
            message: bounded.value,
            truncated: input.truncated || bounded.truncated
        }));
        while (this.#entries.length > this.#maxEntries) {
            this.#entries.shift();
            this.#entriesTruncated = true;
        }
    }

    appendStderr(chunk: Uint8Array): void {
        const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        let offset = 0;
        for (;;) {
            const newline = bytes.indexOf(0x0a, offset);
            if (newline === -1) {
                this.#appendPending(bytes.subarray(offset));
                return;
            }
            this.#appendPending(bytes.subarray(offset, newline));
            this.#commitPendingLine();
            offset = newline + 1;
        }
    }

    flushStderr(): void {
        if (this.#pendingLine.length > 0 || this.#pendingLineTruncated) {
            this.#commitPendingLine();
        }
    }

    snapshot(): RideCodexAppServerDiagnosticSnapshot {
        return Object.freeze({
            entries: Object.freeze(this.#entries.map(entry => Object.freeze({ ...entry }))),
            entriesTruncated: this.#entriesTruncated,
            stderr: Object.freeze({
                lines: Object.freeze([...this.#stderrLines]),
                bytes: this.#stderrBytes,
                truncated: this.#stderrTruncated || this.#pendingLineTruncated
            })
        });
    }

    #appendPending(segment: Buffer): void {
        if (segment.length === 0) {
            return;
        }
        if (segment.length >= this.#maxLineBytes) {
            this.#pendingLine = Buffer.from(segment.subarray(segment.length - this.#maxLineBytes));
            this.#pendingLineTruncated = true;
            this.#stderrTruncated = true;
            return;
        }
        const availableFromPrevious = this.#maxLineBytes - segment.length;
        const previous = this.#pendingLine.length > availableFromPrevious
            ? this.#pendingLine.subarray(this.#pendingLine.length - availableFromPrevious)
            : this.#pendingLine;
        if (previous.length !== this.#pendingLine.length) {
            this.#pendingLineTruncated = true;
            this.#stderrTruncated = true;
        }
        this.#pendingLine = Buffer.concat([previous, segment], previous.length + segment.length);
    }

    #commitPendingLine(): void {
        if (this.#pendingLineTruncated) {
            this.#pendingLine = Buffer.alloc(0);
            this.#pendingLineTruncated = false;
            this.#pushStderrLine('[truncated] <redacted>');
            this.#stderrTruncated = true;
            return;
        }
        let raw = this.#pendingLine;
        if (raw.length > 0 && raw[raw.length - 1] === 0x0d) {
            raw = raw.subarray(0, raw.length - 1);
        }
        const redacted = redactUntrustedText(raw.toString('utf8'));
        const bounded = boundUtf8(redacted, Math.min(this.#maxLineBytes, this.#maxStderrBytes));
        const prefix = this.#pendingLineTruncated || bounded.truncated ? '[truncated] ' : '';
        const final = boundUtf8(`${prefix}${bounded.value}`, Math.min(this.#maxLineBytes, this.#maxStderrBytes));
        this.#pendingLine = Buffer.alloc(0);
        this.#pendingLineTruncated = false;
        if (final.value.length === 0) {
            return;
        }
        this.#pushStderrLine(final.value);
        if (final.truncated || bounded.truncated || prefix.length > 0) {
            this.#stderrTruncated = true;
        }
    }

    #pushStderrLine(line: string): void {
        this.#stderrLines.push(line);
        this.#stderrBytes += Buffer.byteLength(line);
        while (this.#stderrLines.length > this.#maxStderrLines || this.#stderrBytes > this.#maxStderrBytes) {
            const removed = this.#stderrLines.shift();
            if (removed !== undefined) {
                this.#stderrBytes -= Buffer.byteLength(removed);
            }
            this.#stderrTruncated = true;
        }
    }
}

function safeLimit(value: number | undefined, fallback: number, minimum: number, label: string): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < minimum) {
        throw new RangeError(`Maximum ${label} must be a safe integer of at least ${minimum}`);
    }
    return resolved;
}

function redactUntrustedText(value: string): string {
    return value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/\b(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<redacted>@')
        .replace(/\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s,;&]+/gi, 'authorization=<redacted>')
        .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
        .replace(
            /\b((?:openai[\s_-]*)?api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|credential|password|key|token|secret)\b\s*(?:[:=]\s*|\s+)[^\s,;&]+/gi,
            '$1=<redacted>'
        )
        .replace(/\bsk-[A-Za-z0-9_-]+\b/gi, '<redacted>')
        .replace(/(["'])(?:file:\/{2,3}|[A-Za-z]:[\\/]|\\\\|\/)[^"'\r\n]*\1/gi, '<path>')
        .replace(/\bfile:\/{2,3}[^\s,;]+/gi, '<path>')
        .replace(/\\\\[^\r\n]*/g, '<path>')
        .replace(/\b[A-Za-z]:[\\/][^\r\n]*/g, '<path>')
        .replace(/(^|\s)\/(?!\/)[^\r\n]*/g, '$1<path>')
        .replace(/\b[A-Za-z0-9._-]*secret[A-Za-z0-9._-]*\b/gi, '<redacted>')
        .replace(/\b[A-Za-z0-9+/_=-]{64,}\b/g, '<redacted>');
}

function boundUtf8(value: string, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
    const bytes = Buffer.from(value);
    if (bytes.length <= maxBytes) {
        return { value, truncated: false };
    }
    const marker = Buffer.from('…');
    const available = Math.max(0, maxBytes - marker.length);
    let bounded = bytes.subarray(bytes.length - available).toString('utf8');
    if (bounded.charCodeAt(0) === 0xfffd) {
        bounded = bounded.slice(1);
    }
    return { value: `${marker.toString()}${bounded}`, truncated: true };
}
