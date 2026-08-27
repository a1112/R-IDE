/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
    RideCodexAppServerResolver,
    RideCodexAppServerSpawn,
    RideCodexAppServerSpawnOptions
} from './ride-codex-app-server-host';
import { createRideCodexLaunchSpec } from './ride-codex-launch-spec';

/** Set only by the validated Rust packaged-smoke session. */
export const RIDE_CODEX_PACKAGED_SMOKE_NONCE = 'RIDE_CODEX_PACKAGED_SMOKE_NONCE';

const NONCE_PATTERN = /^[a-f0-9]{64}$/u;
const CODEX_SMOKE_VERSION = '0.144.0';
const CODEX_SMOKE_TARGET = 'packaged-smoke';

/**
 * The fixture is deliberately an inline, protocol-only server. It does not
 * import the Codex SDK or contain a native runtime. The Rust gateway supplies
 * the nonce only for an active codex packaged-smoke session, and this source
 * rejects all other launches before reading stdin.
 */
const CODEX_SMOKE_APP_SERVER_SOURCE = String.raw`
const readline = require('node:readline');

const nonce = process.env.RIDE_CODEX_PACKAGED_SMOKE_NONCE;
if (!/^[a-f0-9]{64}$/.test(nonce || '')) {
    process.exit(78);
}

const THREAD_ID = 'codex-smoke-thread';
const state = {
    cwd: process.cwd(),
    threadCreated: false,
    turnSequence: 0,
    active: undefined,
    crashedForRecovery: false
};
const serverRequests = new Map();

function send(message) {
    try {
        process.stdout.write(JSON.stringify(message) + '\n');
    } catch {
        process.exit(79);
    }
}

function response(id, result) {
    send({ id, result });
}

function notification(method, params) {
    send({ method, params });
}

function rawThread(cwd = state.cwd) {
    return {
        id: THREAD_ID,
        sessionId: 'codex-smoke-session',
        forkedFromId: null,
        parentThreadId: null,
        preview: 'Codex packaged smoke',
        ephemeral: false,
        modelProvider: 'openai',
        createdAt: 1,
        updatedAt: 2,
        recencyAt: 2,
        status: { type: 'idle' },
        path: null,
        cwd,
        cliVersion: '0.144.0',
        source: 'appServer',
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: []
    };
}

function rawTurn(id, status = 'inProgress', error = null) {
    return {
        id,
        items: [],
        itemsView: 'full',
        status,
        error,
        startedAt: null,
        completedAt: null,
        durationMs: null
    };
}

function model() {
    return {
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: 'Packaged Codex smoke model',
        isDefault: true,
        hidden: false,
        inputModalities: ['text'],
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
        defaultReasoningEffort: 'medium',
        supportsPersonality: false,
        serviceTiers: [],
        defaultServiceTier: null
    };
}

function activeText(message) {
    return message?.params?.input?.[0]?.text || '';
}

function emitTurnStart(threadId, turnId) {
    notification('turn/started', { threadId, turn: rawTurn(turnId) });
}

function emitTurnComplete(active, status = 'completed') {
    if (!state.active || state.active !== active) {
        return;
    }
    state.active = undefined;
    notification('turn/completed', {
        threadId: active.threadId,
        turn: rawTurn(active.turnId, status)
    });
}

function emitAgentMessage(active) {
    const item = {
        type: 'agentMessage',
        id: 'codex-smoke-agent-item',
        text: '',
        phase: 'commentary'
    };
    notification('item/started', {
        item,
        startedAtMs: 1,
        threadId: active.threadId,
        turnId: active.turnId
    });
    notification('item/agentMessage/delta', {
        delta: 'Codex ',
        itemId: item.id,
        threadId: active.threadId,
        turnId: active.turnId
    });
    notification('item/agentMessage/delta', {
        delta: 'smoke ok',
        itemId: item.id,
        threadId: active.threadId,
        turnId: active.turnId
    });
    notification('item/completed', {
        completedAtMs: 2,
        item: { ...item, text: 'Codex smoke ok', phase: 'final_answer' },
        threadId: active.threadId,
        turnId: active.turnId
    });
}

function emitCommandApproval(active) {
    const itemId = 'codex-smoke-command-item';
    const item = {
        type: 'commandExecution',
        id: itemId,
        command: 'echo codex-smoke',
        cwd: state.cwd,
        status: 'inProgress',
        commandActions: []
    };
    notification('item/started', {
        item,
        startedAtMs: 1,
        threadId: active.threadId,
        turnId: active.turnId
    });
    const requestId = 'codex-smoke-command-approval';
    serverRequests.set(requestId, result => {
        if (result?.decision !== 'accept' && result?.decision !== 'acceptForSession') {
            notification('item/completed', {
                completedAtMs: 2,
                item: { ...item, status: 'declined' },
                threadId: active.threadId,
                turnId: active.turnId
            });
            emitTurnComplete(active, 'interrupted');
            return;
        }
        notification('item/commandExecution/outputDelta', {
            delta: 'codex-smoke\n', itemId, threadId: active.threadId, turnId: active.turnId
        });
        notification('item/completed', {
            completedAtMs: 2,
            item: { ...item, status: 'completed', aggregatedOutput: 'codex-smoke\n', exitCode: 0, durationMs: 1 },
            threadId: active.threadId,
            turnId: active.turnId
        });
        emitAgentMessage(active);
        emitTurnComplete(active);
    });
    send({
        id: requestId,
        method: 'item/commandExecution/requestApproval',
        params: {
            threadId: active.threadId,
            turnId: active.turnId,
            itemId,
            startedAtMs: 1,
            command: 'echo codex-smoke',
            cwd: state.cwd,
            reason: 'Codex packaged smoke command approval'
        }
    });
}

function emitFileApproval(active) {
    const itemId = 'codex-smoke-file-item';
    const changes = [{
        path: 'codex-smoke.txt',
        kind: { type: 'update', move_path: null },
        diff: '+codex smoke\n'
    }];
    const item = { type: 'fileChange', id: itemId, changes, status: 'inProgress' };
    notification('item/started', {
        item,
        startedAtMs: 1,
        threadId: active.threadId,
        turnId: active.turnId
    });
    notification('item/fileChange/patchUpdated', {
        changes,
        itemId,
        threadId: active.threadId,
        turnId: active.turnId
    });
    const requestId = 'codex-smoke-file-approval';
    serverRequests.set(requestId, result => {
        const status = result?.decision === 'accept' || result?.decision === 'acceptForSession'
            ? 'completed' : 'declined';
        notification('item/completed', {
            completedAtMs: 2,
            item: { ...item, status },
            threadId: active.threadId,
            turnId: active.turnId
        });
        emitTurnComplete(active, status === 'completed' ? 'completed' : 'interrupted');
    });
    send({
        id: requestId,
        method: 'item/fileChange/requestApproval',
        params: {
            threadId: active.threadId,
            turnId: active.turnId,
            itemId,
            startedAtMs: 1,
            reason: 'Codex packaged smoke file approval'
        }
    });
}

function startTurn(message) {
    const params = message.params || {};
    const threadId = params.threadId || THREAD_ID;
    const turnId = 'codex-smoke-turn-' + (++state.turnSequence);
    const active = { threadId, turnId };
    state.active = active;
    const text = activeText(message).toLowerCase();
    if (text.includes('recover') && !state.crashedForRecovery) {
        state.crashedForRecovery = true;
        process.exit(42);
        return;
    }
    response(message.id, { turn: rawTurn(turnId) });
    emitTurnStart(threadId, turnId);
    setTimeout(() => {
        if (state.active !== active) {
            return;
        }
        if (text.includes('command')) {
            emitCommandApproval(active);
        } else if (text.includes('file')) {
            emitFileApproval(active);
        } else if (text.includes('interrupt')) {
            emitAgentMessage(active);
        } else {
            emitAgentMessage(active);
            emitTurnComplete(active);
        }
    }, 10);
}

function handleRequest(message) {
    switch (message.method) {
        case 'initialize':
            response(message.id, {});
            return;
        case 'initialized':
            return;
        case 'account/read':
            response(message.id, { account: { type: 'apiKey' }, requiresOpenaiAuth: false });
            return;
        case 'account/rateLimits/read':
            response(message.id, {});
            return;
        case 'account/logout':
            response(message.id, {});
            return;
        case 'model/list':
            response(message.id, { data: [model()], nextCursor: null });
            return;
        case 'thread/list':
            response(message.id, {
                data: state.threadCreated ? [rawThread()] : [],
                nextCursor: null,
                backwardsCursor: null
            });
            return;
        case 'thread/start':
            state.cwd = typeof message.params?.cwd === 'string' ? message.params.cwd : state.cwd;
            state.threadCreated = true;
            notification('thread/started', { thread: rawThread() });
            response(message.id, { thread: rawThread() });
            return;
        case 'thread/resume':
            state.threadCreated = true;
            response(message.id, {
                thread: rawThread(),
                model: 'gpt-5.4',
                modelProvider: 'openai',
                serviceTier: null,
                cwd: state.cwd,
                instructionSources: [],
                approvalPolicy: 'on-request',
                approvalsReviewer: 'user',
                sandbox: {
                    type: 'workspaceWrite',
                    writableRoots: [state.cwd],
                    networkAccess: false,
                    excludeTmpdirEnvVar: false,
                    excludeSlashTmp: false
                },
                reasoningEffort: null
            });
            return;
        case 'thread/read':
            response(message.id, { thread: rawThread() });
            return;
        case 'thread/archive':
            state.threadCreated = false;
            response(message.id, {});
            return;
        case 'turn/start':
            startTurn(message);
            return;
        case 'turn/steer':
            response(message.id, { turnId: message.params?.expectedTurnId });
            return;
        case 'turn/interrupt': {
            response(message.id, {});
            const active = state.active;
            if (active && active.threadId === message.params?.threadId
                && active.turnId === message.params?.turnId) {
                setTimeout(() => emitTurnComplete(active, 'interrupted'), 5);
            }
            return;
        }
        default:
            response(message.id, {});
    }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        process.exit(18);
        return;
    }
    if (!message || typeof message !== 'object') {
        return;
    }
    if (!Object.prototype.hasOwnProperty.call(message, 'method')
        && Object.prototype.hasOwnProperty.call(message, 'id')) {
        const callback = serverRequests.get(String(message.id));
        if (callback) {
            serverRequests.delete(String(message.id));
            callback(message.result);
        }
        return;
    }
    if (typeof message.method === 'string') {
        handleRequest(message);
    }
});
input.on('close', () => process.exit(0));
`;

export function isRideCodexPackagedSmokeEnvironment(
    environment: Readonly<Record<string, string | undefined>> = process.env
): boolean {
    const nonce = environment[RIDE_CODEX_PACKAGED_SMOKE_NONCE];
    return typeof nonce === 'string' && NONCE_PATTERN.test(nonce);
}

export function createRideCodexPackagedSmokeResolver(
    resolver: RideCodexAppServerResolver,
    environment: Readonly<Record<string, string | undefined>> = process.env
): RideCodexAppServerResolver {
    if (!isRideCodexPackagedSmokeEnvironment(environment)) {
        return resolver;
    }
    const nonce = environment[RIDE_CODEX_PACKAGED_SMOKE_NONCE] as string;
    return Object.freeze({
        resolve: async () => {
            const launchSpec = createRideCodexLaunchSpec({
                executable: process.execPath,
                version: CODEX_SMOKE_VERSION,
                target: CODEX_SMOKE_TARGET,
                source: 'system',
                diagnostics: ['Codex packaged smoke fixture']
            });
            return Object.freeze({
                ...launchSpec,
                environment: Object.freeze({
                    [RIDE_CODEX_PACKAGED_SMOKE_NONCE]: nonce
                })
            });
        }
    });
}

export function createRideCodexPackagedSmokeSpawn(
    environment?: Readonly<Record<string, string | undefined>>
): RideCodexAppServerSpawn {
    return (executable, args, options) => isRideCodexPackagedSmokeEnvironment(environment ?? options.env)
        && isRideCodexPackagedSmokeEnvironment(options.env)
        ? spawnFixture(options)
        : spawnDefault(executable, args, options);
}

function spawnFixture(options: RideCodexAppServerSpawnOptions): ChildProcessWithoutNullStreams {
    return nodeSpawn(process.execPath, ['-e', CODEX_SMOKE_APP_SERVER_SOURCE], {
        shell: options.shell,
        stdio: [...options.stdio],
        env: options.env,
        windowsHide: options.windowsHide
    });
}

function spawnDefault(
    executable: string,
    args: readonly string[],
    options: RideCodexAppServerSpawnOptions
): ChildProcessWithoutNullStreams {
    return nodeSpawn(executable, [...args], {
        shell: options.shell,
        stdio: [...options.stdio],
        env: options.env,
        windowsHide: options.windowsHide
    });
}
