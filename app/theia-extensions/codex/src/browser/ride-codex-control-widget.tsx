/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from '@theia/core/shared/react';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import {
    RideCodexApprovalDecision,
    RideCodexApprovalCard
} from '../common/ride-codex-approvals';
import { RideCodexLoginRequest, RideCodexLoginResult } from '../common/ride-codex-auth';
import { RideCodexControlModel, RideCodexControlSnapshot } from './ride-codex-control-model';
import {
    createRideCodexCommandRenderModel,
    createRideCodexFileRenderModel,
    RideCodexCommandOutput,
    RideCodexFileChanges
} from './ride-codex-renderers';
import { RideCodexApprovalDialog } from './ride-codex-approval-dialog';

export const RIDE_CODEX_CONTROL_WIDGET_ID = 'ride-codex-control';

export interface RideCodexControlHandlers {
    onLogin(request: RideCodexLoginRequest): Promise<RideCodexLoginResult>;
    onCancelLogin(): Promise<void>;
    onLogout(): Promise<void>;
    onSelectModel(modelId: string): Promise<void>;
    onSelectThread(threadId: string | null): Promise<void>;
    onStartThread(): Promise<void>;
    onResumeThread(threadId: string): Promise<void>;
    onArchiveThread(threadId: string): Promise<void>;
    onDecideApproval(card: RideCodexApprovalCard, decision: RideCodexApprovalDecision): Promise<void>;
    onInterrupt(): Promise<void>;
    onRetry(): Promise<void>;
}

export interface RideCodexControlContentProps {
    readonly snapshot: RideCodexControlSnapshot;
    readonly handlers: RideCodexControlHandlers;
    readonly locale?: string;
}

export function RideCodexControlContent(props: RideCodexControlContentProps): React.ReactElement {
    const { snapshot, handlers } = props;
    const locale = props.locale ?? defaultLocale();
    const text = createText(locale);
    const [apiKey, setApiKey] = React.useState('');
    const [busyAction, setBusyAction] = React.useState<string | undefined>();
    const run = React.useCallback(async (action: string, operation: () => Promise<unknown>) => {
        setBusyAction(action);
        try {
            await operation();
        } catch {
            // The model publishes a bounded, localized-safe error for the shell.
        } finally {
            setBusyAction(undefined);
        }
    }, []);

    const authenticated = snapshot.auth.state === 'authenticated';
    return <main className='ride-codex-control' aria-label={text.title}>
        <header className='ride-codex-control-header'>
            <div>
                <h2>{text.title}</h2>
                <p>{statusLabel(snapshot, text)}</p>
            </div>
            {authenticated ? <button
                type='button'
                disabled={busyAction !== undefined || snapshot.busy}
                onClick={() => { run('logout', handlers.onLogout); }}
            >{text.logout}</button> : undefined}
        </header>

        {snapshot.progress ? <p className='ride-codex-progress' role='status'>{snapshot.progress}</p> : undefined}
        {snapshot.error ? <section className='ride-codex-error' role='alert'>
            <strong>{snapshot.error.title}</strong>
            <p>{snapshot.error.message}</p>
            {snapshot.error.retryable ? <button
                type='button'
                disabled={busyAction !== undefined}
                onClick={() => { run('retry', handlers.onRetry); }}
            >{text.retry}</button> : undefined}
        </section> : undefined}

        {!authenticated ? <section className='ride-codex-auth'>
            <h3>{text.signIn}</h3>
            {snapshot.auth.pendingLogin?.loginId ? <p role='status'>{text.loginPending}: {snapshot.auth.pendingLogin.loginId}</p> : undefined}
            <div className='ride-codex-auth-actions'>
                <button
                    type='button'
                    disabled={busyAction !== undefined || snapshot.busy}
                    onClick={() => { run('chatgpt', () => handlers.onLogin({ type: 'chatgpt' })); }}
                >{text.chatgptLogin}</button>
                <button
                    type='button'
                    disabled={busyAction !== undefined || snapshot.busy}
                    onClick={() => { run('device', () => handlers.onLogin({ type: 'chatgptDeviceCode' })); }}
                >{text.deviceLogin}</button>
                {snapshot.auth.pendingLogin ? <button
                    type='button'
                    disabled={busyAction !== undefined || snapshot.busy}
                    onClick={() => { run('cancel-login', handlers.onCancelLogin); }}
                >{text.cancel}</button> : undefined}
            </div>
            <form onSubmit={event => {
                event.preventDefault();
                const value = apiKey;
                if (!value.trim()) {
                    return;
                }
                run('api-key', async () => {
                    await handlers.onLogin({ type: 'apiKey', apiKey: value });
                    setApiKey('');
                });
            }}>
                <label>
                    {text.apiKey}
                    <input
                        type='password'
                        value={apiKey}
                        autoComplete='off'
                        onChange={event => setApiKey(event.target.value)}
                    />
                </label>
                <button type='submit' disabled={busyAction !== undefined || snapshot.busy || !apiKey.trim()}>
                    {text.useApiKey}
                </button>
            </form>
        </section> : <>
            <RideCodexSelectors snapshot={snapshot} handlers={handlers} text={text} busy={busyAction !== undefined || snapshot.busy} />
            <RideCodexTurnSummary snapshot={snapshot} handlers={handlers} text={text} busy={busyAction !== undefined} />
            <RideCodexApprovals snapshot={snapshot} handlers={handlers} text={text} busy={busyAction !== undefined || snapshot.busy} />
        </>}
    </main>;
}

interface RideCodexControlText {
    readonly title: string;
    readonly ready: string;
    readonly loading: string;
    readonly authRequired: string;
    readonly error: string;
    readonly disposed: string;
    readonly logout: string;
    readonly retry: string;
    readonly signIn: string;
    readonly chatgptLogin: string;
    readonly deviceLogin: string;
    readonly cancel: string;
    readonly loginPending: string;
    readonly apiKey: string;
    readonly useApiKey: string;
    readonly model: string;
    readonly thread: string;
    readonly newThread: string;
    readonly resume: string;
    readonly archive: string;
    readonly interrupt: string;
    readonly noThread: string;
    readonly noModel: string;
    readonly noApprovals: string;
    readonly approvals: string;
    readonly turn: string;
    readonly noOutput: string;
}

function createText(locale: string): RideCodexControlText {
    const chinese = locale.toLowerCase().startsWith('zh');
    return chinese ? {
        title: 'Codex', ready: '已就绪', loading: '正在加载', authRequired: '需要登录', error: '错误', disposed: '已关闭',
        logout: '退出登录', retry: '重试', signIn: '登录 Codex', chatgptLogin: '使用 ChatGPT 登录', deviceLogin: '设备码登录',
        cancel: '取消', loginPending: '等待登录', apiKey: 'API Key', useApiKey: '使用 API Key', model: '模型', thread: '线程',
        newThread: '新建线程', resume: '恢复', archive: '归档', interrupt: '中断', noThread: '未选择线程', noModel: '无可用模型',
        noApprovals: '没有待处理审批', approvals: '待处理审批', turn: '当前回合', noOutput: '暂无输出'
    } : {
        title: 'Codex', ready: 'Ready', loading: 'Loading', authRequired: 'Sign-in required', error: 'Error', disposed: 'Closed',
        logout: 'Sign out', retry: 'Retry', signIn: 'Sign in to Codex', chatgptLogin: 'Sign in with ChatGPT', deviceLogin: 'Device-code login',
        cancel: 'Cancel', loginPending: 'Waiting for login', apiKey: 'API key', useApiKey: 'Use API key', model: 'Model', thread: 'Thread',
        newThread: 'New thread', resume: 'Resume', archive: 'Archive', interrupt: 'Interrupt', noThread: 'No thread selected', noModel: 'No models available',
        noApprovals: 'No pending approvals', approvals: 'Pending approvals', turn: 'Current turn', noOutput: 'No output yet'
    };
}

function statusLabel(snapshot: RideCodexControlSnapshot, text: RideCodexControlText): string {
    switch (snapshot.phase) {
        case 'ready': return text.ready;
        case 'loading': return text.loading;
        case 'auth-required': return text.authRequired;
        case 'error': return text.error;
        case 'disposed': return text.disposed;
    }
}

function RideCodexSelectors(props: Readonly<{
    snapshot: RideCodexControlSnapshot;
    handlers: RideCodexControlHandlers;
    text: RideCodexControlText;
    busy: boolean;
}>): React.ReactElement {
    const { snapshot, handlers, text, busy } = props;
    return <section className='ride-codex-selectors'>
        <label>{text.model}
            <select
                value={snapshot.selectedModelId ?? ''}
                disabled={busy || snapshot.models.length === 0}
                onChange={event => runSafely(() => handlers.onSelectModel(event.target.value))}
            >
                {snapshot.models.length === 0 ? <option value=''>{text.noModel}</option> : snapshot.models.map(model =>
                    <option value={model.id} key={model.id}>{model.displayName}</option>)}
            </select>
        </label>
        <label>{text.thread}
            <select
                value={snapshot.selectedThreadId ?? ''}
                disabled={busy}
                // The protocol uses null to represent an explicitly cleared selection.
                // eslint-disable-next-line no-null/no-null
                onChange={event => runSafely(() => handlers.onSelectThread(event.target.value || null))}
            >
                <option value=''>{text.noThread}</option>
                {snapshot.conversations.threads.map(thread => <option value={thread.id} key={thread.id}>
                    {thread.name ?? (thread.preview || thread.id)}
                </option>)}
            </select>
        </label>
        <div className='ride-codex-thread-actions'>
            <button type='button' disabled={busy} onClick={() => runSafely(handlers.onStartThread)}>{text.newThread}</button>
            {snapshot.selectedThreadId ? <button
                type='button'
                disabled={busy}
                onClick={() => runSafely(() => handlers.onResumeThread(snapshot.selectedThreadId as string))}
            >{text.resume}</button> : undefined}
            {snapshot.selectedThreadId ? <button
                type='button'
                disabled={busy}
                onClick={() => runSafely(() => handlers.onArchiveThread(snapshot.selectedThreadId as string))}
            >{text.archive}</button> : undefined}
        </div>
    </section>;
}

function RideCodexTurnSummary(props: Readonly<{
    snapshot: RideCodexControlSnapshot;
    handlers: RideCodexControlHandlers;
    text: RideCodexControlText;
    busy: boolean;
}>): React.ReactElement {
    const { snapshot, handlers, text, busy } = props;
    const hasTurnOutput = snapshot.turn.items.length > 0 || snapshot.turn.plan !== undefined || snapshot.turn.diff !== undefined;
    return <section className='ride-codex-turn'>
        <div className='ride-codex-section-heading'>
            <h3>{text.turn}</h3>
            {snapshot.turn.status === 'in-progress' ? <button
                type='button'
                disabled={busy}
                onClick={() => runSafely(handlers.onInterrupt)}
            >{text.interrupt}</button> : undefined}
        </div>
        {!hasTurnOutput ? <p>{text.noOutput}</p> : snapshot.turn.items.map(item => <RideCodexTurnItem item={item} key={item.id} />)}
        {snapshot.turn.plan ? <ol>{snapshot.turn.plan.steps.map((step, index) => <li key={`${index}:${step.step}`}>
            <span>{step.status}</span> {step.step}
        </li>)}</ol> : undefined}
        {snapshot.turn.diff ? <pre>{snapshot.turn.diff}</pre> : undefined}
    </section>;
}

function RideCodexTurnItem(props: Readonly<{ item: RideCodexControlSnapshot['turn']['items'][number] }>): React.ReactElement {
    const { item } = props;
    if (item.kind === 'command') {
        const model = createRideCodexCommandRenderModel(item);
        return <article className='ride-codex-turn-item' data-kind={item.kind}>
            {model ? <RideCodexCommandOutput model={model} /> : undefined}
        </article>;
    }
    if (item.kind === 'file-change') {
        const model = createRideCodexFileRenderModel(item);
        return <article className='ride-codex-turn-item' data-kind={item.kind}>
            {model ? <RideCodexFileChanges model={model} /> : undefined}
        </article>;
    }
    return <article className='ride-codex-turn-item' data-kind={item.kind}>
        {item.reasoning.length > 0 ? <details>
            <summary>Reasoning</summary>
            <pre>{item.reasoning.join('\n')}</pre>
        </details> : undefined}
        {item.text ? <pre>{item.text}</pre> : undefined}
    </article>;
}

function RideCodexApprovals(props: Readonly<{
    snapshot: RideCodexControlSnapshot;
    handlers: RideCodexControlHandlers;
    text: RideCodexControlText;
    busy: boolean;
}>): React.ReactElement {
    const { snapshot, handlers, text, busy } = props;
    return <section className='ride-codex-approvals'>
        <h3>{text.approvals}</h3>
        {snapshot.approvals.length === 0 ? <p>{text.noApprovals}</p> : snapshot.approvals.map(card =>
            <RideCodexApprovalDialog
                key={card.token}
                state={{ approval: card, busy }}
                onDecision={decision => runSafely(() => handlers.onDecideApproval(card, decision))}
            />)}
    </section>;
}

export class RideCodexControlWidget extends ReactWidget {
    readonly #model: RideCodexControlModel;
    readonly #handlers: RideCodexControlHandlers;
    readonly #locale: string;

    constructor(model: RideCodexControlModel, handlers: RideCodexControlHandlers, locale = defaultLocale()) {
        super();
        this.#model = model;
        this.#handlers = handlers;
        this.#locale = locale;
        this.id = RIDE_CODEX_CONTROL_WIDGET_ID;
        this.title.label = 'Codex';
        this.title.caption = 'Codex';
        this.title.iconClass = 'codicon codicon-hubot';
        this.title.closable = true;
        this.addClass('ride-codex-control-widget');
        this.toDispose.push(this.#model.onDidChange(() => this.update()));
    }

    protected render(): React.ReactNode {
        return <RideCodexControlContent
            snapshot={this.#model.snapshot()}
            handlers={this.#handlers}
            locale={this.#locale}
        />;
    }
}

function defaultLocale(): string {
    return typeof navigator === 'undefined' ? 'en' : navigator.language;
}

function runSafely(operation: () => Promise<unknown>): void {
    operation().catch(() => undefined);
}
