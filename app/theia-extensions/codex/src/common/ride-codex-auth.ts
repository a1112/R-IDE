/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export type RideCodexAuthState =
    | 'inactive'
    | 'disconnected'
    | 'unauthenticated'
    | 'authenticating'
    | 'authenticated'
    | 'error';

export type RideCodexAuthAccount =
    | Readonly<{ type: 'apiKey' }>
    | Readonly<{ type: 'chatgpt'; email?: string; plan: RideCodexPlan }>;

export type RideCodexPlan =
    | 'free' | 'go' | 'plus' | 'pro' | 'prolite' | 'team'
    | 'self_serve_business_usage_based' | 'business'
    | 'enterprise_cbp_usage_based' | 'enterprise' | 'edu' | 'unknown';

export interface RideCodexRateLimitWindow {
    readonly usedPercent: number;
    readonly windowDurationMins?: number;
    readonly resetsAt?: number;
}

export interface RideCodexCredits {
    readonly hasCredits: boolean;
    readonly unlimited: boolean;
    readonly balance?: string;
}

export interface RideCodexRateLimitBucket {
    readonly limitId?: string;
    readonly limitName?: string;
    readonly primary?: RideCodexRateLimitWindow;
    readonly secondary?: RideCodexRateLimitWindow;
    readonly credits?: RideCodexCredits;
    readonly plan?: RideCodexPlan;
}

export interface RideCodexRateLimits extends RideCodexRateLimitBucket {
    readonly byLimitId?: Readonly<Record<string, RideCodexRateLimitBucket>>;
    readonly resetCredits?: Readonly<{ availableCount: string }>;
}

export type RideCodexLoginRequest =
    | Readonly<{ type: 'apiKey'; apiKey: string }>
    | Readonly<{ type: 'chatgpt' }>
    | Readonly<{ type: 'chatgptDeviceCode' }>;

export type RideCodexLoginResult =
    | Readonly<{ type: 'apiKey' }>
    | Readonly<{ type: 'chatgpt'; loginId: string; authUrl: string }>
    | Readonly<{
        type: 'chatgptDeviceCode';
        loginId: string;
        verificationUrl: string;
        userCode: string;
    }>;

export interface RideCodexAuthSnapshot {
    readonly state: RideCodexAuthState;
    readonly account?: RideCodexAuthAccount;
    readonly rateLimits?: RideCodexRateLimits;
    readonly pendingLogin?: Readonly<{ type: RideCodexLoginRequest['type']; loginId?: string }>;
    readonly error?: Readonly<{ code: string; message: string }>;
}

export interface RideCodexAccountReadResult {
    readonly account?: RideCodexAuthAccount;
    readonly requiresOpenaiAuth: boolean;
}

export interface RideCodexAuthClient {
    authStateChanged(snapshot: RideCodexAuthSnapshot): void;
}

const MAX_EMAIL_LENGTH = 512;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_URL_LENGTH = 2_048;
const MAX_USER_CODE_LENGTH = 64;
const MAX_LABEL_LENGTH = 256;
const MAX_BALANCE_LENGTH = 128;
const MAX_RATE_LIMIT_BUCKETS = 16;
const MAX_RECORD_PROPERTIES = 32;
const MAX_ERROR_CODE_LENGTH = 64;
const MAX_ERROR_MESSAGE_LENGTH = 160;
export const MAX_CODEX_API_KEY_LENGTH = 8 * 1024;

const PLANS = new Set<RideCodexPlan>([
    'free', 'go', 'plus', 'pro', 'prolite', 'team', 'self_serve_business_usage_based',
    'business', 'enterprise_cbp_usage_based', 'enterprise', 'edu', 'unknown'
]);
const AUTH_STATES = new Set<RideCodexAuthState>([
    'inactive', 'disconnected', 'unauthenticated', 'authenticating', 'authenticated', 'error'
]);

export function normalizeRideCodexAccount(value: unknown): RideCodexAuthAccount | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    const record = requireRecord(value, 'account');
    const type = requireString(readOwn(record, 'type'), 'account type', 32);
    if (type === 'apiKey') {
        requireOnlyKeys(record, ['type'], 'API key account');
        return Object.freeze({ type: 'apiKey' });
    }
    if (type !== 'chatgpt') {
        throw new TypeError('Unsupported Codex account type');
    }
    requireOnlyKeys(record, ['type', 'email', 'planType'], 'ChatGPT account');
    const emailValue = readOwn(record, 'email');
    const email = emailValue === null || emailValue === undefined
        ? undefined
        : requireString(emailValue, 'account email', MAX_EMAIL_LENGTH);
    const plan = requirePlan(readOwn(record, 'planType'));
    return Object.freeze({ type: 'chatgpt', ...(email === undefined ? {} : { email }), plan });
}

export function normalizeRideCodexAccountReadResult(value: unknown): RideCodexAccountReadResult {
    const record = requireRecord(value, 'account response');
    requireOnlyKeys(record, ['account', 'requiresOpenaiAuth'], 'account response');
    return Object.freeze({
        account: normalizeRideCodexAccount(readOwn(record, 'account')),
        requiresOpenaiAuth: requireBoolean(readOwn(record, 'requiresOpenaiAuth'), 'OpenAI auth requirement')
    });
}

export function normalizeRideCodexCancelResult(value: unknown): 'canceled' | 'notFound' {
    const record = requireRecord(value, 'cancel-login response');
    requireOnlyKeys(record, ['status'], 'cancel-login response');
    const status = readOwn(record, 'status');
    if (status !== 'canceled' && status !== 'notFound') {
        throw new TypeError('Unsupported Codex cancel-login status');
    }
    return status;
}

export function normalizeRideCodexLoginCompletion(value: unknown): Readonly<{
    loginId?: string;
    success: boolean;
}> {
    const record = requireRecord(value, 'login completion');
    requireOnlyKeys(record, ['loginId', 'success', 'error'], 'login completion');
    const loginIdValue = readOwn(record, 'loginId');
    const loginId = loginIdValue === null || loginIdValue === undefined
        ? undefined
        : requireIdentifier(loginIdValue, 'login ID');
    return Object.freeze({
        ...(loginId === undefined ? {} : { loginId }),
        success: requireBoolean(readOwn(record, 'success'), 'login success')
    });
}

export function normalizeRideCodexAccountUpdate(value: unknown): RideCodexAuthAccount | undefined {
    const record = requireRecord(value, 'account update');
    requireOnlyKeys(record, ['authMode', 'planType'], 'account update');
    const authMode = readOwn(record, 'authMode');
    const planValue = readOwn(record, 'planType');
    if (authMode === null) {
        if (planValue !== null) {
            throw new TypeError('Codex account update is inconsistent');
        }
        return undefined;
    }
    if (authMode === 'apikey') {
        if (planValue !== null) {
            throw new TypeError('Codex API key account update is inconsistent');
        }
        return Object.freeze({ type: 'apiKey' });
    }
    if (authMode === 'chatgpt' || authMode === 'chatgptAuthTokens') {
        return Object.freeze({
            type: 'chatgpt',
            plan: planValue === null ? 'unknown' : requirePlan(planValue)
        });
    }
    throw new TypeError('Unsupported Codex account auth mode');
}

export function normalizeRideCodexLoginResult(value: unknown): RideCodexLoginResult {
    const record = requireRecord(value, 'login result');
    const type = requireString(readOwn(record, 'type'), 'login type', 32);
    if (type === 'apiKey') {
        requireOnlyKeys(record, ['type'], 'API key login result');
        return Object.freeze({ type: 'apiKey' });
    }
    if (type === 'chatgpt') {
        requireOnlyKeys(record, ['type', 'loginId', 'authUrl'], 'browser login result');
        return Object.freeze({
            type,
            loginId: requireIdentifier(readOwn(record, 'loginId'), 'login ID'),
            authUrl: requireHttpsUrl(readOwn(record, 'authUrl'), 'authentication URL')
        });
    }
    if (type === 'chatgptDeviceCode') {
        requireOnlyKeys(record, ['type', 'loginId', 'verificationUrl', 'userCode'], 'device-code login result');
        return Object.freeze({
            type,
            loginId: requireIdentifier(readOwn(record, 'loginId'), 'login ID'),
            verificationUrl: requireHttpsUrl(readOwn(record, 'verificationUrl'), 'verification URL'),
            userCode: requireString(readOwn(record, 'userCode'), 'device user code', MAX_USER_CODE_LENGTH)
        });
    }
    throw new TypeError('Unsupported Codex login result type');
}

export function normalizeRideCodexRateLimits(value: unknown): RideCodexRateLimits | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    const response = requireRecord(value, 'rate-limit response');
    requireOnlyKeys(response, [
        'rateLimits', 'rateLimitsByLimitId', 'rateLimitResetCredits'
    ], 'rate-limit response');
    const current = normalizeRateLimitBucket(readOwn(response, 'rateLimits'));
    const byLimitValue = readOwn(response, 'rateLimitsByLimitId');
    const resetCreditsValue = readOwn(response, 'rateLimitResetCredits');
    const byLimitId = byLimitValue === null || byLimitValue === undefined
        ? undefined
        : normalizeRateLimitRecord(byLimitValue);
    const resetCredits = resetCreditsValue === null || resetCreditsValue === undefined
        ? undefined
        : normalizeResetCredits(resetCreditsValue);
    return Object.freeze({
        ...current,
        ...(byLimitId === undefined ? {} : { byLimitId }),
        ...(resetCredits === undefined ? {} : { resetCredits })
    });
}

export function normalizeRideCodexRateLimitUpdate(value: unknown): RideCodexRateLimitBucket {
    const notification = requireRecord(value, 'rate-limit notification');
    requireOnlyKeys(notification, ['rateLimits'], 'rate-limit notification');
    return normalizeRateLimitBucket(readOwn(notification, 'rateLimits'));
}

export function normalizeRideCodexLoginRequest(request: unknown): RideCodexLoginRequest {
    const record = requireRecord(request, 'login request');
    const type = requireString(readOwn(record, 'type'), 'login type', 32);
    if (type === 'apiKey') {
        requireOnlyKeys(record, ['type', 'apiKey'], 'API key login request');
        const apiKey = requireString(readOwn(record, 'apiKey'), 'API key', MAX_CODEX_API_KEY_LENGTH);
        if (apiKey.length < 8) {
            throw new TypeError('Codex API key is invalid');
        }
        return Object.freeze({ type, apiKey });
    }
    if (type === 'chatgpt' || type === 'chatgptDeviceCode') {
        requireOnlyKeys(record, ['type'], 'ChatGPT login request');
        return Object.freeze({ type });
    }
    throw new TypeError('Unsupported Codex login type');
}

export function createRideCodexAuthSnapshot(value: RideCodexAuthSnapshot): RideCodexAuthSnapshot {
    const record = requireRecord(value, 'auth snapshot');
    requireOnlyKeys(record, ['state', 'account', 'rateLimits', 'pendingLogin', 'error'], 'auth snapshot');
    const state = readOwn(record, 'state');
    if (typeof state !== 'string' || !AUTH_STATES.has(state as RideCodexAuthState)) {
        throw new TypeError('Unsupported Codex auth state');
    }
    const account = normalizePublicAccount(readOwn(record, 'account'));
    const rateLimits = normalizePublicRateLimits(readOwn(record, 'rateLimits'));
    const pendingLogin = normalizePendingLogin(readOwn(record, 'pendingLogin'));
    const error = normalizeAuthError(readOwn(record, 'error'));
    if (state === 'authenticated' && account === undefined) {
        throw new TypeError('Authenticated Codex state requires an account');
    }
    if (state === 'error' && error === undefined) {
        throw new TypeError('Codex error state requires a bounded error');
    }
    return Object.freeze({
        state: state as RideCodexAuthState,
        ...(account === undefined ? {} : { account }),
        ...(rateLimits === undefined ? {} : { rateLimits }),
        ...(pendingLogin === undefined ? {} : { pendingLogin }),
        ...(error === undefined ? {} : { error })
    });
}

function normalizeRateLimitBucket(value: unknown): RideCodexRateLimitBucket {
    const record = requireRecord(value, 'rate-limit bucket');
    requireOnlyKeys(record, [
        'limitId', 'limitName', 'primary', 'secondary', 'credits', 'individualLimit',
        'planType', 'rateLimitReachedType'
    ], 'rate-limit bucket');
    const limitId = optionalString(readOwn(record, 'limitId'), 'rate-limit ID', MAX_IDENTIFIER_LENGTH);
    const limitName = optionalString(readOwn(record, 'limitName'), 'rate-limit name', MAX_LABEL_LENGTH);
    const primary = optionalWindow(readOwn(record, 'primary'));
    const secondary = optionalWindow(readOwn(record, 'secondary'));
    const credits = optionalCredits(readOwn(record, 'credits'));
    const planValue = readOwn(record, 'planType');
    const plan = planValue === null || planValue === undefined ? undefined : requirePlan(planValue);
    return Object.freeze({
        ...(limitId === undefined ? {} : { limitId }),
        ...(limitName === undefined ? {} : { limitName }),
        ...(primary === undefined ? {} : { primary }),
        ...(secondary === undefined ? {} : { secondary }),
        ...(credits === undefined ? {} : { credits }),
        ...(plan === undefined ? {} : { plan })
    });
}

function normalizeRateLimitRecord(value: unknown): Readonly<Record<string, RideCodexRateLimitBucket>> {
    const record = requireRecord(value, 'rate-limit buckets');
    const keys = Object.keys(record);
    if (keys.length > MAX_RATE_LIMIT_BUCKETS) {
        throw new RangeError('Too many Codex rate-limit buckets');
    }
    const output: Record<string, RideCodexRateLimitBucket> = Object.create(null);
    for (const key of keys.sort()) {
        const safeKey = requireString(key, 'rate-limit bucket ID', MAX_IDENTIFIER_LENGTH);
        output[safeKey] = normalizeRateLimitBucket(readOwn(record, key));
    }
    return Object.freeze(output);
}

function optionalWindow(value: unknown): RideCodexRateLimitWindow | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    const record = requireRecord(value, 'rate-limit window');
    requireOnlyKeys(record, ['usedPercent', 'windowDurationMins', 'resetsAt'], 'rate-limit window');
    const usedPercent = requireFiniteNumber(readOwn(record, 'usedPercent'), 'used percent', 0, 100);
    const durationValue = readOwn(record, 'windowDurationMins');
    const resetsValue = readOwn(record, 'resetsAt');
    const windowDurationMins = durationValue === null || durationValue === undefined
        ? undefined
        : requireSafeInteger(durationValue, 'window duration', 0);
    const resetsAt = resetsValue === null || resetsValue === undefined
        ? undefined
        : requireSafeInteger(resetsValue, 'reset timestamp', 0);
    return Object.freeze({
        usedPercent,
        ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
        ...(resetsAt === undefined ? {} : { resetsAt })
    });
}

function optionalCredits(value: unknown): RideCodexCredits | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    const record = requireRecord(value, 'credits');
    requireOnlyKeys(record, ['hasCredits', 'unlimited', 'balance'], 'credits');
    const hasCredits = requireBoolean(readOwn(record, 'hasCredits'), 'has credits');
    const unlimited = requireBoolean(readOwn(record, 'unlimited'), 'unlimited credits');
    const balanceValue = readOwn(record, 'balance');
    const balance = balanceValue === null || balanceValue === undefined
        ? undefined
        : requireDecimalString(balanceValue, 'credit balance', MAX_BALANCE_LENGTH);
    return Object.freeze({ hasCredits, unlimited, ...(balance === undefined ? {} : { balance }) });
}

function normalizeResetCredits(value: unknown): Readonly<{ availableCount: string }> {
    const record = requireRecord(value, 'reset credits');
    requireOnlyKeys(record, ['availableCount', 'credits'], 'reset credits');
    const raw = readOwn(record, 'availableCount');
    let availableCount: string;
    if (typeof raw === 'bigint') {
        availableCount = raw.toString();
    } else if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) {
        availableCount = String(raw);
    } else {
        availableCount = requireDecimalString(raw, 'reset credit count', 64);
    }
    if (!/^\d+$/.test(availableCount)) {
        throw new TypeError('Reset credit count is invalid');
    }
    return Object.freeze({ availableCount });
}

function normalizePublicAccount(value: unknown): RideCodexAuthAccount | undefined {
    if (value === undefined) {
        return undefined;
    }
    const record = requireRecord(value, 'public account');
    const type = readOwn(record, 'type');
    if (type === 'apiKey') {
        requireOnlyKeys(record, ['type'], 'public API key account');
        return Object.freeze({ type });
    }
    if (type === 'chatgpt') {
        requireOnlyKeys(record, ['type', 'email', 'plan'], 'public ChatGPT account');
        const email = optionalString(readOwn(record, 'email'), 'account email', MAX_EMAIL_LENGTH);
        const plan = requirePlan(readOwn(record, 'plan'));
        return Object.freeze({ type, ...(email === undefined ? {} : { email }), plan });
    }
    throw new TypeError('Unsupported public account type');
}

function normalizePublicRateLimits(value: unknown): RideCodexRateLimits | undefined {
    if (value === undefined) {
        return undefined;
    }
    const record = requireRecord(value, 'public rate limits');
    const bucket = normalizePublicBucket(record);
    const byLimitValue = readOwn(record, 'byLimitId');
    const resetValue = readOwn(record, 'resetCredits');
    let byLimitId: Readonly<Record<string, RideCodexRateLimitBucket>> | undefined;
    if (byLimitValue !== undefined) {
        const byLimitRecord = requireRecord(byLimitValue, 'public rate-limit buckets');
        const entries: Record<string, RideCodexRateLimitBucket> = Object.create(null);
        const keys = Object.keys(byLimitRecord);
        if (keys.length > MAX_RATE_LIMIT_BUCKETS) {
            throw new RangeError('Too many public Codex rate-limit buckets');
        }
        for (const key of keys.sort()) {
            entries[requireString(key, 'rate-limit bucket ID', MAX_IDENTIFIER_LENGTH)] =
                normalizePublicBucket(requireRecord(readOwn(byLimitRecord, key), 'public rate-limit bucket'));
        }
        byLimitId = Object.freeze(entries);
    }
    let resetCredits: Readonly<{ availableCount: string }> | undefined;
    if (resetValue !== undefined) {
        const resetRecord = requireRecord(resetValue, 'public reset credits');
        requireOnlyKeys(resetRecord, ['availableCount'], 'public reset credits');
        resetCredits = Object.freeze({
            availableCount: requireDecimalString(readOwn(resetRecord, 'availableCount'), 'reset credit count', 64)
        });
    }
    return Object.freeze({
        ...bucket,
        ...(byLimitId === undefined ? {} : { byLimitId }),
        ...(resetCredits === undefined ? {} : { resetCredits })
    });
}

function normalizePublicBucket(record: Record<string, unknown>): RideCodexRateLimitBucket {
    requireOnlyKeys(record, [
        'limitId', 'limitName', 'primary', 'secondary', 'credits', 'plan', 'byLimitId', 'resetCredits'
    ], 'public rate-limit bucket');
    const limitId = optionalString(readOwn(record, 'limitId'), 'rate-limit ID', MAX_IDENTIFIER_LENGTH);
    const limitName = optionalString(readOwn(record, 'limitName'), 'rate-limit name', MAX_LABEL_LENGTH);
    const primary = optionalWindow(readOwn(record, 'primary'));
    const secondary = optionalWindow(readOwn(record, 'secondary'));
    const credits = optionalCredits(readOwn(record, 'credits'));
    const planValue = readOwn(record, 'plan');
    const plan = planValue === undefined ? undefined : requirePlan(planValue);
    return Object.freeze({
        ...(limitId === undefined ? {} : { limitId }),
        ...(limitName === undefined ? {} : { limitName }),
        ...(primary === undefined ? {} : { primary }),
        ...(secondary === undefined ? {} : { secondary }),
        ...(credits === undefined ? {} : { credits }),
        ...(plan === undefined ? {} : { plan })
    });
}

function normalizePendingLogin(value: unknown): RideCodexAuthSnapshot['pendingLogin'] {
    if (value === undefined) {
        return undefined;
    }
    const record = requireRecord(value, 'pending login');
    requireOnlyKeys(record, ['type', 'loginId'], 'pending login');
    const type = readOwn(record, 'type');
    if (type !== 'apiKey' && type !== 'chatgpt' && type !== 'chatgptDeviceCode') {
        throw new TypeError('Unsupported pending login type');
    }
    const loginIdValue = readOwn(record, 'loginId');
    const loginId = loginIdValue === undefined ? undefined : requireIdentifier(loginIdValue, 'login ID');
    return Object.freeze({ type, ...(loginId === undefined ? {} : { loginId }) });
}

function normalizeAuthError(value: unknown): RideCodexAuthSnapshot['error'] {
    if (value === undefined) {
        return undefined;
    }
    const record = requireRecord(value, 'auth error');
    requireOnlyKeys(record, ['code', 'message'], 'auth error');
    return Object.freeze({
        code: requireString(readOwn(record, 'code'), 'auth error code', MAX_ERROR_CODE_LENGTH),
        message: requireString(readOwn(record, 'message'), 'auth error message', MAX_ERROR_MESSAGE_LENGTH)
    });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError(`Codex ${label} must be a record`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`Codex ${label} must be a plain record`);
    }
    if (Object.getOwnPropertyNames(value).length > MAX_RECORD_PROPERTIES) {
        throw new RangeError(`Codex ${label} has too many properties`);
    }
    return value as Record<string, unknown>;
}

function readOwn(record: Record<string, unknown>, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor) {
        return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.get || descriptor.set) {
        throw new TypeError('Codex data contains an unsafe property');
    }
    return descriptor.value;
}

function requireOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
    const allowedSet = new Set(allowed);
    for (const key of Object.getOwnPropertyNames(record)) {
        if (!allowedSet.has(key)) {
            throw new TypeError(`Codex ${label} contains an unsupported property`);
        }
        readOwn(record, key);
    }
}

function requireString(value: unknown, label: string, maxLength: number): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new TypeError(`Codex ${label} is invalid`);
    }
    return value;
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
    return value === null || value === undefined ? undefined : requireString(value, label, maxLength);
}

function requireIdentifier(value: unknown, label: string): string {
    return requireString(value, label, MAX_IDENTIFIER_LENGTH);
}

function requireHttpsUrl(value: unknown, label: string): string {
    const text = requireString(value, label, MAX_URL_LENGTH);
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        throw new TypeError(`Codex ${label} is invalid`);
    }
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
        throw new TypeError(`Codex ${label} must be an HTTPS URL`);
    }
    return url.toString();
}

function requirePlan(value: unknown): RideCodexPlan {
    if (typeof value !== 'string' || !PLANS.has(value as RideCodexPlan)) {
        throw new TypeError('Unsupported Codex account plan');
    }
    return value as RideCodexPlan;
}

function requireBoolean(value: unknown, label: string): boolean {
    if (typeof value !== 'boolean') {
        throw new TypeError(`Codex ${label} must be a boolean`);
    }
    return value;
}

function requireFiniteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
        throw new TypeError(`Codex ${label} is invalid`);
    }
    return value;
}

function requireSafeInteger(value: unknown, label: string, minimum: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
        throw new TypeError(`Codex ${label} is invalid`);
    }
    return value;
}

function requireDecimalString(value: unknown, label: string, maxLength: number): string {
    const text = requireString(value, label, maxLength);
    if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
        throw new TypeError(`Codex ${label} is invalid`);
    }
    return text;
}
