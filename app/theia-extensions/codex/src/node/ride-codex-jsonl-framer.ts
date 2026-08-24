/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export class RideCodexJsonlFramer {
    protected buffered: Buffer = Buffer.alloc(0);
    protected failed = false;

    constructor(protected readonly maxLineBytes: number) {
        if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
            throw new RangeError('JSONL maximum byte length must be a positive safe integer');
        }
    }

    push(chunk: Uint8Array): Uint8Array[] {
        if (this.failed) {
            throw new Error('JSONL framer is closed after a framing error');
        }

        const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const lines: Uint8Array[] = [];
        let offset = 0;
        let newline = bytes.indexOf(0x0a, offset);

        try {
            while (newline !== -1) {
                const segment = bytes.subarray(offset, newline);
                const rawLength = this.buffered.length + segment.length;
                const endsWithCarriageReturn = segment.length > 0
                    ? segment[segment.length - 1] === 0x0d
                    : this.buffered.length > 0 && this.buffered[this.buffered.length - 1] === 0x0d;
                const lineLength = rawLength - (endsWithCarriageReturn ? 1 : 0);
                this.assertWithinLimit(lineLength);

                const rawLine = this.joinBuffered(segment, rawLength);
                const line = endsWithCarriageReturn ? rawLine.subarray(0, rawLine.length - 1) : rawLine;
                lines.push(Buffer.from(line));
                this.buffered = Buffer.alloc(0);
                offset = newline + 1;
                newline = bytes.indexOf(0x0a, offset);
            }

            const remainder = bytes.subarray(offset);
            if (remainder.length > 0) {
                const rawLength = this.buffered.length + remainder.length;
                const endsWithCarriageReturn = remainder[remainder.length - 1] === 0x0d;
                const bufferedLength = rawLength - (endsWithCarriageReturn ? 1 : 0);
                this.assertWithinLimit(bufferedLength);
                this.buffered = this.joinBuffered(remainder, rawLength);
            }
            return lines;
        } catch (error) {
            this.failed = true;
            this.buffered = Buffer.alloc(0);
            throw error;
        }
    }

    protected assertWithinLimit(length: number): void {
        if (length > this.maxLineBytes) {
            throw new RangeError(`JSONL line exceeds maximum byte length of ${this.maxLineBytes}`);
        }
    }

    protected joinBuffered(segment: Uint8Array, length: number): Buffer {
        if (this.buffered.length === 0) {
            return Buffer.from(segment);
        }
        const joined = Buffer.allocUnsafe(length);
        this.buffered.copy(joined, 0);
        joined.set(segment, this.buffered.length);
        return joined;
    }
}
