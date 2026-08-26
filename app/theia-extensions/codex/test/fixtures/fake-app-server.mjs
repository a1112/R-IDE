#!/usr/bin/env node

import readline from 'node:readline';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const mode = process.env.RIDE_FAKE_APP_SERVER_MODE ?? 'normal';
const barrierDirectory = process.argv[2];
let initialized = false;
let initializeParams;

function writeMessage(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function writeStderrFlood() {
    const payload = 'x'.repeat(2_048);
    for (let index = 0; index < 1_024; index += 1) {
        if (!process.stderr.write(`noise-${index}-${payload}\n`)) {
            await new Promise(resolve => process.stderr.once('drain', resolve));
        }
    }
    process.stderr.write('Authorization: Bearer bearer-secret-value\n');
    process.stderr.write('api_key=api-secret-value token=token-secret-value secret=plain-secret-value\n');
    process.stderr.write('failed at C:\\Users\\private-user\\very\\long\\secret\\workspace\\project.txt\n');
    process.stderr.write(`unterminated-${'tail-secret-'.repeat(1_024)}`);
}

async function signalStdinEofAndWaitForRelease(waitForRelease) {
    if (!barrierDirectory) {
        throw new Error('The shutdown barrier directory is required');
    }
    await writeFile(join(barrierDirectory, 'stdin-eof'), `${process.pid}\n`, { flag: 'wx' });
    process.stderr.write('RIDE_FAKE_STDIN_EOF\n');
    if (!waitForRelease) {
        setInterval(() => undefined, 1_000);
        return;
    }
    const releaseSentinel = join(barrierDirectory, 'release');
    while (true) {
        try {
            await access(releaseSentinel);
            process.exit(0);
            return;
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

if (mode === 'early-exit') {
    setImmediate(() => process.exit(17));
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async line => {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        process.exit(18);
        return;
    }

    if (message.method === 'initialize') {
        initializeParams = message.params;
        if (mode === 'early-exit') {
            return;
        }
        if (mode === 'handshake-timeout') {
            return;
        }
        if (mode === 'malformed') {
            process.stdout.write('{malformed-json}\n');
            return;
        }
        if (mode === 'stderr-flood') {
            await writeStderrFlood();
        }
        writeMessage({
            id: message.id,
            result: {
                initializeParams: message.params,
                argv: process.argv.slice(2)
            }
        });
        return;
    }

    if (message.method === 'initialized') {
        initialized = true;
        if (mode === 'crash-after-initialize') {
            setTimeout(() => process.exit(23), 20);
        }
        return;
    }

    if (message.params?.fixture === 'pending') {
        return;
    }
    if (message.params?.fixture === 'crash') {
        process.exit(24);
        return;
    }
    writeMessage({
        id: message.id,
        result: {
            initialized,
            ...(message.params?.fixture === 'report-initialize' ? { initializeParams } : {}),
            method: message.method,
            pid: process.pid
        }
    });
});

input.on('close', () => {
    if (mode === 'barrier-stdin-close' || mode === 'barrier-ignore-stdin-close') {
        void signalStdinEofAndWaitForRelease(mode === 'barrier-stdin-close').catch(() => {
            process.stderr.write('RIDE_FAKE_BARRIER_ERROR\n');
            process.exit(19);
        });
        return;
    }
    if (mode === 'delayed-stdin-close' || mode === 'ignore-stdin-close') {
        process.stderr.write('RIDE_FAKE_STDIN_EOF\n');
    }
    if (mode === 'delayed-stdin-close') {
        setTimeout(() => process.exit(0), 30);
        return;
    }
    if (mode === 'ignore-stdin-close') {
        setTimeout(() => process.stderr.write('RIDE_FAKE_BEFORE_GRACE\n'), 25);
        setInterval(() => undefined, 1_000);
        return;
    }
    process.exit(0);
});
