/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { resolve } from 'node:path';
import { types as utilTypes } from 'node:util';
import {
    createRideCodexInstallPresentation,
    InstallPresentation
} from '../common/ride-codex-installation';
import {
    InstallAuthorization,
    InstallAuthorizationContext,
    InstallAuthorizationLease,
    InstallAuthorizationValidator
} from './ride-codex-runtime-fetcher';
import {
    RideCodexRuntimeManifestEntry,
    runtimeManifestEntryDigest
} from './ride-codex-runtime-manifest';
import { requiredRuntimeStageBytes } from './ride-codex-runtime-stager';

const INSTALL_CONSENT_TOKEN_BRAND: unique symbol = Symbol('ride-codex-install-consent-token');
const INSTALL_AUTHORIZATION_MARKER: unique symbol = Symbol('ride-codex-install-authorization');
export type InstallConsentToken = Readonly<{ readonly [INSTALL_CONSENT_TOKEN_BRAND]: true }>;

export interface ConsumedInstallConsent {
    readonly presentation: InstallPresentation;
    readonly authorization: InstallAuthorization;
}

export interface RideCodexInstallConsentOptions {
    readonly clock?: () => number;
    readonly ttlMs?: number;
}

interface ConsentRecord {
    readonly presentation: InstallPresentation;
    readonly issuedAt: number;
    readonly expiresAt: number;
}

interface AuthorizationRecord {
    readonly target: string;
    readonly manifestDigest: string;
    readonly canonicalRoot: string;
    readonly issuedAt: number;
    readonly expiresAt: number;
}

const DEFAULT_TTL_MS = 60_000;
const MAX_TTL_MS = 5 * 60_000;

export class RideCodexInstallConsentError extends Error {
    constructor(message = 'Matching Codex install consent is required.') {
        super(message);
        this.name = 'RideCodexInstallConsentError';
    }
}

export class RideCodexInstallConsent {
    private readonly clock: () => number;
    private readonly ttlMs: number;
    private readonly tokens = new WeakMap<object, ConsentRecord>();
    private readonly authorizations = new WeakMap<object, AuthorizationRecord>();

    readonly authorizationValidator: InstallAuthorizationValidator = (authorization, context) =>
        this.consumeAuthorization(authorization, context);

    constructor(options: RideCodexInstallConsentOptions = {}) {
        this.clock = options.clock ?? (() => performance.now());
        this.ttlMs = positiveDuration(options.ttlMs, DEFAULT_TTL_MS);
        if (this.ttlMs > MAX_TTL_MS) {
            throw new RideCodexInstallConsentError('Codex install consent lifetime exceeds the safe limit.');
        }
    }

    issue(presentation: InstallPresentation): InstallConsentToken {
        const snapshot = snapshotPresentation(presentation);
        const issuedAt = this.readClock();
        const token = Object.freeze({}) as InstallConsentToken;
        this.tokens.set(token, Object.freeze({
            presentation: snapshot,
            issuedAt,
            expiresAt: issuedAt + this.ttlMs
        }));
        return token;
    }

    consume(token: InstallConsentToken | undefined, expected?: InstallPresentation): ConsumedInstallConsent {
        if (typeof token !== 'object' || !token) {
            throw new RideCodexInstallConsentError();
        }
        const record = this.tokens.get(token);
        if (!record) {
            throw new RideCodexInstallConsentError('Codex install consent is invalid or already used.');
        }
        this.tokens.delete(token);
        const now = this.readClock();
        if (now < record.issuedAt || now >= record.expiresAt) {
            throw new RideCodexInstallConsentError('Codex install consent expired.');
        }
        if (expected) {
            const normalizedExpected = snapshotPresentation(expected);
            if (!presentationsEqual(record.presentation, normalizedExpected)) {
                throw new RideCodexInstallConsentError('Codex install consent does not match the displayed installation.');
            }
        }
        const authorization = Object.freeze({ [INSTALL_AUTHORIZATION_MARKER]: true }) as InstallAuthorization;
        this.authorizations.set(authorization, Object.freeze({
            target: record.presentation.target,
            manifestDigest: record.presentation.manifestDigest,
            canonicalRoot: resolve(record.presentation.installRoot),
            issuedAt: record.issuedAt,
            expiresAt: record.expiresAt
        }));
        return Object.freeze({ presentation: record.presentation, authorization });
    }

    private consumeAuthorization(
        authorization: InstallAuthorization,
        context: InstallAuthorizationContext
    ): false | InstallAuthorizationLease {
        if (typeof authorization !== 'object' || !authorization) {
            return false;
        }
        const record = this.authorizations.get(authorization);
        if (!record) {
            return false;
        }
        this.authorizations.delete(authorization);
        let now: number;
        try {
            now = this.readClock();
        } catch {
            return false;
        }
        if (now < record.issuedAt
            || now >= record.expiresAt
            || record.target !== context.target
            || record.manifestDigest !== context.manifestDigest
            || !samePath(record.canonicalRoot, resolve(context.canonicalRoot))) {
            return false;
        }
        return Object.freeze({
            issuedAt: record.issuedAt,
            expiresAt: record.expiresAt,
            now: () => this.readClock()
        });
    }

    private readClock(): number {
        const now = this.clock();
        if (!Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - this.ttlMs) {
            throw new RideCodexInstallConsentError('Codex install consent clock is invalid.');
        }
        return now;
    }
}

function snapshotPresentation(presentation: InstallPresentation): InstallPresentation {
    if (typeof presentation !== 'object' || !presentation || utilTypes.isProxy(presentation)) {
        throw new RideCodexInstallConsentError('Codex install presentation contains an unsafe object.');
    }
    try {
        return createRideCodexInstallPresentation(presentation);
    } catch {
        throw new RideCodexInstallConsentError('Codex install presentation is invalid or unsafe.');
    }
}

export function createRideCodexRuntimeInstallPresentation(
    runtime: RideCodexRuntimeManifestEntry,
    installRoot: string
): InstallPresentation {
    const url = new URL(runtime.url);
    return createRideCodexInstallPresentation({
        source: 'official-npm-registry',
        version: runtime.version,
        target: runtime.target,
        urlOrigin: url.origin,
        installRoot: resolve(installRoot),
        requiredSpaceBytes: requiredRuntimeStageBytes(runtime),
        rollbackPolicy: 'retain-new-and-previous-valid',
        manifestDigest: runtimeManifestEntryDigest(runtime)
    });
}

function presentationsEqual(left: InstallPresentation, right: InstallPresentation): boolean {
    return left.source === right.source
        && left.version === right.version
        && left.target === right.target
        && left.urlOrigin === right.urlOrigin
        && samePath(left.installRoot, right.installRoot)
        && left.requiredSpaceBytes === right.requiredSpaceBytes
        && left.rollbackPolicy === right.rollbackPolicy
        && left.manifestDigest === right.manifestDigest;
}

function samePath(left: string, right: string): boolean {
    const normalizedLeft = resolve(left);
    const normalizedRight = resolve(right);
    return process.platform === 'win32'
        ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
        : normalizedLeft === normalizedRight;
}

function positiveDuration(value: number | undefined, fallback: number): number {
    const candidate = value ?? fallback;
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
        throw new RideCodexInstallConsentError('Codex install consent lifetime is invalid.');
    }
    return candidate;
}
