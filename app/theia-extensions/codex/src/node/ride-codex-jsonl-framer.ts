/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export class RideCodexJsonlFramer {
    protected readonly buffered: Buffer[] = [];
    protected bufferedBytes = 0;
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
                this.appendBuffered(segment);
                const endsWithCarriageReturn = this.endsWithCarriageReturn();

                const rawLine = this.joinBuffered();
                const line = endsWithCarriageReturn ? rawLine.subarray(0, rawLine.length - 1) : rawLine;
                lines.push(Buffer.from(line));
                this.clearBuffered();
                offset = newline + 1;
                newline = bytes.indexOf(0x0a, offset);
            }

            const remainder = bytes.subarray(offset);
            if (remainder.length > 0) {
                this.appendBuffered(remainder);
            }
            return lines;
        } catch (error) {
            this.failed = true;
            this.clearBuffered();
            throw error;
        }
    }

    protected assertWithinLimit(length: number): void {
        if (length > this.maxLineBytes) {
            throw new RangeError(`JSONL line exceeds maximum byte length of ${this.maxLineBytes}`);
        }
    }

    protected appendBuffered(segment: Uint8Array): void {
        if (segment.length === 0) {
            return;
        }
        const nextLength = this.bufferedBytes + segment.length;
        const endsWithCarriageReturn = segment[segment.length - 1] === 0x0d;
        this.assertWithinLimit(nextLength - (endsWithCarriageReturn ? 1 : 0));
        this.buffered.push(Buffer.from(segment));
        this.bufferedBytes = nextLength;
    }

    protected endsWithCarriageReturn(): boolean {
        const last = this.buffered[this.buffered.length - 1];
        return last !== undefined && last[last.length - 1] === 0x0d;
    }

    protected joinBuffered(): Buffer {
        if (this.buffered.length === 0) {
            return Buffer.alloc(0);
        }
        if (this.buffered.length === 1) {
            return this.buffered[0];
        }
        return Buffer.concat(this.buffered, this.bufferedBytes);
    }

    protected clearBuffered(): void {
        this.buffered.length = 0;
        this.bufferedBytes = 0;
    }
}
