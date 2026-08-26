#!/usr/bin/env node

import readline from 'node:readline';

const mode = process.env.RIDE_FAKE_APP_SERVER_MODE ?? 'normal';
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
    if (mode === 'ignore-stdin-close') {
        setInterval(() => undefined, 1_000);
        return;
    }
    process.exit(0);
});
