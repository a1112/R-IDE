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

export interface RideCodexTransientSecretScope {
    dispose(): void;
}

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_ENTRY_BYTES = 160;
const DEFAULT_MAX_STDERR_LINES = 64;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_MAX_LINE_BYTES = 512;
const MAX_TRANSIENT_SECRETS = 32;
const MAX_TRANSIENT_SECRET_LENGTH = 8 * 1024;
const MIN_TRANSIENT_SECRET_FRAGMENT_LENGTH = 4;

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
    readonly #transientSecrets = new Map<symbol, string>();
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

    get transientSecretCount(): number {
        return this.#transientSecrets.size;
    }

    registerTransientSecret(secret: string): RideCodexTransientSecretScope {
        if (typeof secret !== 'string' || secret.length < MIN_TRANSIENT_SECRET_FRAGMENT_LENGTH
            || secret.length > MAX_TRANSIENT_SECRET_LENGTH || /[\u0000-\u001f\u007f]/.test(secret)) {
            throw new TypeError('Transient diagnostic secret is invalid');
        }
        if (this.#transientSecrets.size >= MAX_TRANSIENT_SECRETS) {
            throw new RangeError('Maximum transient diagnostic secret count reached');
        }
        const token = Symbol('transient-secret');
        this.#transientSecrets.set(token, secret);
        let disposed = false;
        return Object.freeze({
            dispose: () => {
                if (!disposed) {
                    disposed = true;
                    this.#transientSecrets.delete(token);
                }
            }
        });
    }

    record(code: RideCodexAppServerDiagnosticCode, detail?: unknown): void {
        const raw = typeof detail === 'string' && detail.trim().length > 0
            ? detail
            : DEFAULT_MESSAGE_BY_CODE[code];
        const input = boundUtf8(raw, this.#maxEntryBytes);
        const redacted = input.truncated
            ? '[truncated] <redacted>'
            : this.#redactTransientSecrets(redactUntrustedText(input.value));
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
        const redacted = this.#redactTransientSecrets(redactUntrustedText(raw.toString('utf8')));
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

    #redactTransientSecrets(value: string): string {
        let redacted = value;
        for (const secret of this.#transientSecrets.values()) {
            redacted = redactTransientSecret(redacted, secret);
        }
        return redacted;
    }
}

function redactTransientSecret(value: string, secret: string): string {
    if (value.length < MIN_TRANSIENT_SECRET_FRAGMENT_LENGTH) {
        return value;
    }
    let cursor = 0;
    let scan = 0;
    let output = '';
    while (scan <= value.length - MIN_TRANSIENT_SECRET_FRAGMENT_LENGTH) {
        const probe = value.slice(scan, scan + MIN_TRANSIENT_SECRET_FRAGMENT_LENGTH);
        const secretIndex = secret.indexOf(probe);
        if (secretIndex < 0) {
            scan += 1;
            continue;
        }
        let valueStart = scan;
        let secretStart = secretIndex;
        while (valueStart > cursor && secretStart > 0 && value[valueStart - 1] === secret[secretStart - 1]) {
            valueStart -= 1;
            secretStart -= 1;
        }
        let valueEnd = scan + MIN_TRANSIENT_SECRET_FRAGMENT_LENGTH;
        let secretEnd = secretIndex + MIN_TRANSIENT_SECRET_FRAGMENT_LENGTH;
        while (valueEnd < value.length && secretEnd < secret.length && value[valueEnd] === secret[secretEnd]) {
            valueEnd += 1;
            secretEnd += 1;
        }
        output += `${value.slice(cursor, valueStart)}<redacted>`;
        cursor = valueEnd;
        scan = valueEnd;
    }
    return cursor === 0 ? value : output + value.slice(cursor);
}

function safeLimit(value: number | undefined, fallback: number, minimum: number, label: string): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < minimum) {
        throw new RangeError(`Maximum ${label} must be a safe integer of at least ${minimum}`);
    }
    return resolved;
}

function redactUntrustedText(value: string): string {
    const sanitized = value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/\b(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<redacted>@')
        .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>');
    return redactCredentialAssignments(sanitized)
        .replace(/\bsk-[A-Za-z0-9_-]+\b/gi, '<redacted>')
        .replace(/(["'])(?:file:\/{2,3}|[A-Za-z]:[\\/]|\\\\|\/)[^"'\r\n]*\1/gi, '<path>')
        .replace(/\bfile:\/{2,3}[^\r\n,;)"'\]}]*/gi, '<path>')
        .replace(/\\\\[^\r\n]*/g, '<path>')
        .replace(/\b[A-Za-z]:[\\/][^\r\n]*/g, '<path>')
        .replace(/(^|[\s=:(\[,])\/(?!\/)[^\r\n,;)"'\]}]*/g, '$1<path>')
        .replace(/\b[A-Za-z0-9._-]*secret[A-Za-z0-9._-]*\b/gi, '<redacted>')
        .replace(/\b[A-Za-z0-9+/_=-]{64,}\b/g, '<redacted>');
}

interface CredentialAssignment {
    readonly valueStart: number;
    readonly end: number;
}

function redactCredentialAssignments(value: string): string {
    let cursor = 0;
    let scan = 0;
    let redacted = '';
    while (scan < value.length) {
        const assignment = readCredentialAssignment(value, scan);
        if (assignment === undefined) {
            scan += 1;
            continue;
        }
        redacted += value.slice(cursor, assignment.valueStart);
        redacted += '<redacted>';
        cursor = assignment.end;
        scan = assignment.end;
    }
    return cursor === 0 ? value : redacted + value.slice(cursor);
}

function readCredentialAssignment(value: string, start: number): CredentialAssignment | undefined {
    const quote = value[start] === '"' || value[start] === "'" ? value[start] : undefined;
    let fieldStart = start;
    let fieldEnd: number;
    if (quote !== undefined) {
        fieldStart += 1;
        fieldEnd = fieldStart;
        while (fieldEnd < value.length && isCredentialFieldCharacter(value[fieldEnd]) && fieldEnd - fieldStart < 128) {
            fieldEnd += 1;
        }
        if (fieldEnd === fieldStart || value[fieldEnd] !== quote) {
            return undefined;
        }
    } else {
        if (!isAsciiLetter(value[start]) || (start > 0 && isCredentialFieldCharacter(value[start - 1]))) {
            return undefined;
        }
        fieldEnd = start + 1;
        while (fieldEnd < value.length && isCredentialFieldCharacter(value[fieldEnd]) && fieldEnd - start < 128) {
            fieldEnd += 1;
        }
    }

    const fieldName = value.slice(fieldStart, fieldEnd);
    if (!isSensitiveCredentialField(fieldName)) {
        return undefined;
    }
    const authorizationField = isAuthorizationCredentialField(fieldName);

    let separator = quote === undefined ? fieldEnd : fieldEnd + 1;
    const whitespaceStart = separator;
    while (separator < value.length && isHorizontalWhitespace(value[separator])) {
        separator += 1;
    }
    if (value[separator] === ':' || value[separator] === '=') {
        separator += 1;
        while (separator < value.length && isHorizontalWhitespace(value[separator])) {
            separator += 1;
        }
    } else if (quote !== undefined || separator === whitespaceStart) {
        return undefined;
    }
    if (separator >= value.length || value[separator] === '\r' || value[separator] === '\n') {
        return undefined;
    }

    return {
        valueStart: separator,
        end: readCredentialValueEnd(value, separator, authorizationField)
    };
}

function readCredentialValueEnd(value: string, start: number, authorizationField: boolean): number {
    const quote = value[start] === '"' || value[start] === "'" ? value[start] : undefined;
    if (quote !== undefined) {
        let quotedIndex = start + 1;
        while (quotedIndex < value.length) {
            if (value[quotedIndex] === '\\') {
                quotedIndex = Math.min(value.length, quotedIndex + 2);
            } else if (value[quotedIndex] === quote) {
                return quotedIndex + 1;
            } else {
                quotedIndex += 1;
            }
        }
        return value.length;
    }
    if (authorizationField) {
        let lineIndex = start;
        while (lineIndex < value.length && value[lineIndex] !== '\r' && value[lineIndex] !== '\n') {
            lineIndex += 1;
        }
        return lineIndex;
    }
    let index = start;
    while (index < value.length && !isCredentialValueDelimiter(value[index])) {
        index += 1;
    }
    return index;
}

function isSensitiveCredentialField(fieldName: string): boolean {
    const segments = credentialFieldSegments(fieldName);
    if (segments.length === 0) {
        return false;
    }
    if (isAuthorizationCredentialSegments(segments)) {
        return true;
    }
    const sensitiveSegments = new Set(['secret', 'password', 'passwd', 'token', 'credential']);
    if (segments.some(segment => sensitiveSegments.has(segment))) {
        return true;
    }
    if (segments.length === 1 && segments[0] === 'key') {
        return true;
    }
    const sensitiveKeyQualifiers = new Set(['private', 'api', 'signing', 'access']);
    for (let index = 1; index < segments.length; index += 1) {
        if (segments[index] === 'key' && sensitiveKeyQualifiers.has(segments[index - 1])) {
            return true;
        }
    }
    const collapsed = segments.join('');
    return ['secret', 'password', 'passwd', 'token', 'credential', 'privatekey', 'apikey', 'signingkey', 'accesskey']
        .some(suffix => collapsed === suffix || collapsed.endsWith(suffix));
}

function isAuthorizationCredentialField(fieldName: string): boolean {
    return isAuthorizationCredentialSegments(credentialFieldSegments(fieldName));
}

function isAuthorizationCredentialSegments(segments: readonly string[]): boolean {
    const collapsed = segments.join('');
    return collapsed === 'authorization'
        || collapsed === 'proxyauthorization'
        || collapsed === 'authenticate'
        || collapsed === 'wwwauthenticate'
        || collapsed === 'proxyauthenticate';
}

function credentialFieldSegments(fieldName: string): string[] {
    return fieldName
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .filter(segment => segment.length > 0)
        .map(segment => segment.toLowerCase());
}

function isAsciiLetter(value: string): boolean {
    const code = value.charCodeAt(0);
    return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isCredentialFieldCharacter(value: string): boolean {
    const code = value.charCodeAt(0);
    return isAsciiLetter(value)
        || (code >= 0x30 && code <= 0x39)
        || value === '_'
        || value === '-'
        || value === '.';
}

function isHorizontalWhitespace(value: string): boolean {
    return value === ' ' || value === '\t';
}

function isCredentialValueDelimiter(value: string): boolean {
    return value === '\r'
        || value === '\n'
        || value === ','
        || value === ';'
        || value === '&'
        || value === '}';
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
