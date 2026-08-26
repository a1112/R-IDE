/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    createRideCodexAuthSnapshot,
    MAX_CODEX_API_KEY_LENGTH,
    RideCodexAuthClient,
    RideCodexAuthSnapshot,
    RideCodexLoginRequest,
    RideCodexLoginResult
} from '../common/ride-codex-auth';

export const LEGACY_CODEX_API_KEY_PREFERENCES = Object.freeze([
    'ai-features.codex.apiKey',
    'ai-features.openai.apiKey',
    'openai.apiKey'
] as const);

export interface RideCodexLegacyPreferenceAccess {
    read(name: string): unknown;
    remove(name: string, expectedValue: string): Promise<boolean>;
}

export interface RideCodexMigrationPrompt {
    confirmLegacyApiKeyMigration(sources: readonly string[]): Promise<boolean>;
}

export interface RideCodexAuthControllerService {
    activate(): Promise<RideCodexAuthSnapshot>;
    readAccount(options?: Readonly<{ refreshToken?: boolean }>): Promise<RideCodexAuthSnapshot>;
    login(request: RideCodexLoginRequest): Promise<RideCodexLoginResult>;
    status(): Promise<RideCodexAuthSnapshot>;
}

export type RideCodexAuthControllerState =
    | 'inactive' | 'activating' | 'ready' | 'migrated' | 'manual' | 'recovery-required';

export interface RideCodexAuthControllerSnapshot {
    readonly state: RideCodexAuthControllerState;
    readonly sources?: readonly string[];
    readonly message?: string;
}

export interface RideCodexAuthControllerOptions {
    readonly preferences: RideCodexLegacyPreferenceAccess;
    readonly prompt: RideCodexMigrationPrompt;
    readonly auth: RideCodexAuthControllerService;
}

export class RideCodexAuthClientRelay implements RideCodexAuthClient {
    #listener: RideCodexAuthClient | undefined;
    #lastSnapshot: RideCodexAuthSnapshot | undefined;

    attach(listener: RideCodexAuthClient): void {
        this.#listener = listener;
        if (this.#lastSnapshot) {
            listener.authStateChanged(this.#lastSnapshot);
        }
    }

    authStateChanged(snapshot: RideCodexAuthSnapshot): void {
        let normalized: RideCodexAuthSnapshot;
        try {
            normalized = createRideCodexAuthSnapshot(snapshot);
        } catch {
            normalized = createRideCodexAuthSnapshot({
                state: 'error',
                error: {
                    code: 'invalid-data',
                    message: 'Codex authentication returned invalid data.'
                }
            });
        }
        this.#lastSnapshot = normalized;
        this.#listener?.authStateChanged(normalized);
    }
}

const CONTROLLER_MESSAGES = Object.freeze({
    conflict: 'Multiple legacy Codex API key preferences conflict. Resolve them manually.',
    invalid: 'A legacy Codex API key preference is invalid. Resolve it manually.',
    declined: 'Legacy Codex API key migration was declined. Manual handling is required.',
    login: 'Codex authentication could not confirm the legacy API key. The preference was retained.',
    race: 'A legacy Codex API key preference changed during migration. Manual handling is required.',
    deletion: 'Codex authenticated, but legacy preference cleanup needs manual recovery.',
    verification: 'Legacy preference cleanup could not be verified. Manual recovery is required.',
    activation: 'Codex authentication could not be activated. Try again or handle authentication manually.'
});

export class RideCodexAuthController implements RideCodexAuthClient {
    readonly #preferences: RideCodexLegacyPreferenceAccess;
    readonly #prompt: RideCodexMigrationPrompt;
    readonly #auth: RideCodexAuthControllerService;
    #snapshot: RideCodexAuthControllerSnapshot = Object.freeze({ state: 'inactive' });
    #activation: Promise<RideCodexAuthControllerSnapshot> | undefined;
    #prompted = false;
    #disposed = false;
    #authSnapshot: RideCodexAuthSnapshot = Object.freeze({ state: 'inactive' });

    constructor(options: RideCodexAuthControllerOptions) {
        this.#preferences = options.preferences;
        this.#prompt = options.prompt;
        this.#auth = options.auth;
    }

    snapshot(): RideCodexAuthControllerSnapshot {
        return this.#snapshot;
    }

    authStateChanged(snapshot: RideCodexAuthSnapshot): void {
        if (!this.#disposed) {
            this.#authSnapshot = snapshot;
        }
    }

    activate(): Promise<RideCodexAuthControllerSnapshot> {
        if (this.#disposed) {
            return Promise.reject(new Error('Codex auth controller is disposed.'));
        }
        if (this.#snapshot.state !== 'inactive' && this.#snapshot.state !== 'activating') {
            return Promise.resolve(this.#snapshot);
        }
        if (this.#activation) {
            return this.#activation;
        }
        this.#snapshot = Object.freeze({ state: 'activating' });
        const operation = this.#activateOnce();
        this.#activation = operation;
        void operation.catch(() => undefined);
        return operation;
    }

    dispose(): void {
        this.#disposed = true;
    }

    async #activateOnce(): Promise<RideCodexAuthControllerSnapshot> {
        const scan = this.#readLegacyPreferences();
        if (scan.kind === 'invalid') {
            return this.#finish('manual', scan.sources, CONTROLLER_MESSAGES.invalid);
        }
        if (scan.kind === 'conflict') {
            return this.#finish('manual', scan.sources, CONTROLLER_MESSAGES.conflict);
        }
        if (scan.entries.length === 0) {
            try {
                this.#authSnapshot = await this.#auth.activate();
                this.#authSnapshot = await this.#auth.readAccount({ refreshToken: false });
                return this.#finish('ready');
            } catch {
                return this.#finish('recovery-required', undefined, CONTROLLER_MESSAGES.activation);
            }
        }
        if (this.#prompted) {
            return this.#finish('manual', scan.entries.map(entry => entry.name), CONTROLLER_MESSAGES.declined);
        }
        this.#prompted = true;
        const sources = Object.freeze(scan.entries.map(entry => entry.name));
        let accepted = false;
        try {
            accepted = await this.#prompt.confirmLegacyApiKeyMigration(sources);
        } catch {
            return this.#finish('manual', sources, CONTROLLER_MESSAGES.declined);
        }
        if (!accepted) {
            return this.#finish('manual', sources, CONTROLLER_MESSAGES.declined);
        }

        let secret = scan.entries[0].value;
        try {
            await this.#auth.login({ type: 'apiKey', apiKey: secret });
            this.#authSnapshot = await this.#auth.status();
            if (this.#authSnapshot.state !== 'authenticated' || this.#authSnapshot.account?.type !== 'apiKey') {
                return this.#finish('recovery-required', sources, CONTROLLER_MESSAGES.login);
            }
            for (const entry of scan.entries) {
                if (this.#readPreference(entry.name) !== entry.value) {
                    return this.#finish('recovery-required', sources, CONTROLLER_MESSAGES.race);
                }
                let removed: boolean;
                try {
                    removed = await this.#preferences.remove(entry.name, entry.value);
                } catch {
                    return this.#finish('recovery-required', sources, CONTROLLER_MESSAGES.deletion);
                }
                if (!removed) {
                    return this.#finish('recovery-required', sources, CONTROLLER_MESSAGES.race);
                }
            }
            for (const entry of scan.entries) {
                if (this.#readPreference(entry.name) !== undefined) {
                    return this.#finish('recovery-required', sources, CONTROLLER_MESSAGES.verification);
                }
            }
            return this.#finish('migrated', sources);
        } catch {
            return this.#finish('recovery-required', sources, CONTROLLER_MESSAGES.login);
        } finally {
            secret = '';
        }
    }

    #readLegacyPreferences():
        | { kind: 'valid'; entries: Array<{ name: string; value: string }> }
        | { kind: 'invalid' | 'conflict'; sources: readonly string[]; entries: [] } {
        const entries: Array<{ name: string; value: string }> = [];
        for (const name of LEGACY_CODEX_API_KEY_PREFERENCES) {
            const value = this.#readPreference(name);
            if (value === undefined) {
                continue;
            }
            if (!isBoundedLegacySecret(value)) {
                return { kind: 'invalid', sources: Object.freeze([name]), entries: [] };
            }
            entries.push({ name, value });
        }
        if (new Set(entries.map(entry => entry.value)).size > 1) {
            return { kind: 'conflict', sources: Object.freeze(entries.map(entry => entry.name)), entries: [] };
        }
        return { kind: 'valid', entries };
    }

    #readPreference(name: string): unknown {
        try {
            return this.#preferences.read(name);
        } catch {
            return INVALID_PREFERENCE;
        }
    }

    #finish(
        state: Exclude<RideCodexAuthControllerState, 'inactive' | 'activating'>,
        sources?: readonly string[],
        message?: string
    ): RideCodexAuthControllerSnapshot {
        this.#snapshot = Object.freeze({
            state,
            ...(sources === undefined ? {} : { sources: Object.freeze([...sources]) }),
            ...(message === undefined ? {} : { message })
        });
        return this.#snapshot;
    }
}

const INVALID_PREFERENCE = Symbol('invalid-preference');

function isBoundedLegacySecret(value: unknown): value is string {
    return typeof value === 'string'
        && value.length >= 8
        && value.length <= MAX_CODEX_API_KEY_LENGTH
        && !/[\u0000-\u001f\u007f]/.test(value);
}
