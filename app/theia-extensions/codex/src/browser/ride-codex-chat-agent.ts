/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Event } from '@theia/core';
import {
    ChatAgent,
    ChatAgentLocation,
    ChatAgentService,
    ChatResponseContent,
    ErrorChatResponseContentImpl,
    MarkdownChatResponseContentImpl,
    MutableChatRequestModel,
    ThinkingChatResponseContentImpl
} from '@theia/ai-chat';
import {
    RideCodexControlSnapshot
} from './ride-codex-control-model';
import { mapRideCodexError, RideCodexMappedError } from './ride-codex-error-mapper';
import {
    RideCodexRenderedItem,
    RideCodexTurnResult
} from '../common/ride-codex-events';
import {
    createRideCodexCommandRenderModel,
    createRideCodexFileRenderModel
} from './ride-codex-renderers';

export interface RideCodexChatAgentRuntime {
    readonly onDidChange: Event<RideCodexControlSnapshot>;
    snapshot(): RideCodexControlSnapshot;
    submitTurn(prompt: string, clientMessageId?: string): Promise<RideCodexTurnResult>;
    interruptTurn(): Promise<RideCodexTurnResult>;
}

interface RideCodexResponseWriter {
    readonly response: {
        addContent(content: ChatResponseContent): void;
    };
    readonly cancellationToken: {
        readonly onCancellationRequested: Event<void>;
    };
    complete(): void;
    cancel(): void;
    error(error: Error): void;
}

interface ItemCursor {
    textLength: number;
    reasoningLength: number;
    renderedFileSignature?: string;
    renderedCommandSignature?: string;
}

/**
 * The real interactive Theia agent. It is loaded only by the explicit Codex
 * feature chunk; the startup proxy owns the stable contribution identity.
 */
export class RideCodexChatAgent implements ChatAgent {
    readonly id = 'Codex';
    readonly name = 'Codex';
    readonly description = 'Use the R-IDE Codex App Server for workspace-aware coding tasks.';
    readonly variables: string[] = [];
    readonly prompts = [];
    readonly languageModelRequirements = [];
    readonly agentSpecificVariables = [];
    readonly functions: string[] = [];
    readonly tags = ['codex', 'workspace'];
    readonly locations = ChatAgentLocation.ALL.slice();
    readonly iconClass = 'codicon codicon-hubot';
    readonly modes = [{ id: 'default', name: 'Default', isDefault: true }];

    constructor(protected readonly runtime: RideCodexChatAgentRuntime) { }

    async invoke(request: MutableChatRequestModel, _chatAgentService?: ChatAgentService): Promise<void> {
        const writer = request.response as unknown as RideCodexResponseWriter;
        const renderer = new RideCodexResponseRenderer(writer);
        let canceled = false;
        let changeListener: { dispose(): void } | undefined;
        let cancellationListener: { dispose(): void } | undefined;
        try {
            changeListener = this.runtime.onDidChange(nextSnapshot => renderer.render(nextSnapshot));
            cancellationListener = writer.cancellationToken.onCancellationRequested(() => {
                if (canceled) {
                    return;
                }
                canceled = true;
                this.runtime.interruptTurn().catch(() => undefined);
            });
            renderer.render(this.runtime.snapshot());
            const result = await this.runtime.submitTurn(stripAgentMention(request.request.text), request.id);
            const currentSnapshot = this.runtime.snapshot();
            renderer.render(currentSnapshot);
            this.finish(writer, result, currentSnapshot, canceled);
        } catch {
            const currentSnapshot = this.runtime.snapshot();
            renderer.render(currentSnapshot);
            this.fail(writer, errorForSnapshot(currentSnapshot));
        } finally {
            cancellationListener?.dispose();
            changeListener?.dispose();
        }
    }

    protected finish(
        writer: RideCodexResponseWriter,
        result: RideCodexTurnResult,
        snapshot: RideCodexControlSnapshot,
        canceled: boolean
    ): void {
        if (canceled || result.status === 'interrupted') {
            writer.cancel();
            return;
        }
        if (result.status === 'completed') {
            writer.complete();
            return;
        }
        this.fail(writer, errorForResult(result, snapshot));
    }

    protected fail(writer: RideCodexResponseWriter, mapped: RideCodexMappedError): void {
        const error = new Error(mapped.message);
        writer.response.addContent(new ErrorChatResponseContentImpl(error));
        writer.error(error);
    }
}

class RideCodexResponseRenderer {
    readonly #cursors = new Map<string, ItemCursor>();
    readonly #diagnostics = new Set<string>();
    #planSignature: string | undefined;

    constructor(protected readonly writer: RideCodexResponseWriter) { }

    render(snapshot: RideCodexControlSnapshot): void {
        for (const item of snapshot.turn.items) {
            this.renderItem(item);
        }
        this.renderPlan(snapshot);
        for (const warning of snapshot.turn.warnings) {
            const key = `warning:${warning.code}`;
            if (this.#diagnostics.has(key)) {
                continue;
            }
            this.#diagnostics.add(key);
            this.addMarkdown(`\n> Codex warning: ${safeWarning(warning.code)}\n`);
        }
    }

    protected renderItem(item: RideCodexRenderedItem): void {
        const cursor = this.#cursors.get(item.id) ?? { textLength: 0, reasoningLength: 0 };
        this.#cursors.set(item.id, cursor);
        if (item.kind === 'reasoning') {
            const reasoning = item.reasoning.join('\n');
            const reasoningDelta = suffix(reasoning, cursor.reasoningLength);
            cursor.reasoningLength = reasoning.length;
            if (reasoningDelta) {
                this.writer.response.addContent(new ThinkingChatResponseContentImpl(reasoningDelta, ''));
            }
            return;
        }
        if (item.kind === 'file-change') {
            const file = createRideCodexFileRenderModel(item);
            if (!file) {
                return;
            }
            const signature = file.changes.map(change => change.operation === 'move'
                ? `${change.operation}:${change.fromPath}:${change.toPath}:${change.diff}`
                : `${change.operation}:${change.path}:${change.diff}`).join('\u0000');
            if (signature && signature !== cursor.renderedFileSignature) {
                cursor.renderedFileSignature = signature;
                this.addMarkdown(renderFileChanges(file));
            }
            return;
        }
        if (item.kind === 'command') {
            const command = createRideCodexCommandRenderModel(item);
            if (command && command.output && command.output !== cursor.renderedCommandSignature) {
                cursor.renderedCommandSignature = command.output;
                this.addMarkdown(`\n${codeFence(command.output, 'text')}\n`);
            }
            return;
        }
        if (item.kind === 'user-message') {
            return;
        }
        const delta = suffix(item.text, cursor.textLength);
        cursor.textLength = item.text.length;
        if (delta) {
            this.addMarkdown(delta);
        }
    }

    protected renderPlan(snapshot: RideCodexControlSnapshot): void {
        const plan = snapshot.turn.plan;
        if (!plan) {
            return;
        }
        const signature = `${plan.explanation ?? ''}\u0000${plan.steps.map(step =>
            `${step.status}:${step.step}`).join('\u0000')}`;
        if (signature === this.#planSignature) {
            return;
        }
        this.#planSignature = signature;
        const lines = plan.steps.map((step, index) =>
            `${index + 1}. [${step.status}] ${escapeMarkdown(step.step)}`);
        this.addMarkdown(`\n**Codex plan**${plan.explanation ? ` — ${escapeMarkdown(plan.explanation)}` : ''}\n${lines.join('\n')}\n`);
    }

    protected addMarkdown(value: string): void {
        this.writer.response.addContent(new MarkdownChatResponseContentImpl(value));
    }
}

function stripAgentMention(value: string): string {
    return value.replace(/^@Codex(?:\s+|$)/i, '').trim();
}

function suffix(value: string, previousLength: number): string {
    if (previousLength > 0 && value.length >= previousLength) {
        return value.slice(previousLength);
    }
    return value;
}

function errorForSnapshot(snapshot: RideCodexControlSnapshot): RideCodexMappedError {
    if (snapshot.error) {
        return snapshot.error;
    }
    const error = snapshot.turn.errors[snapshot.turn.errors.length - 1];
    return mapRideCodexError(error?.code, snapshot.phase === 'auth-required' ? 'auth' : 'turn');
}

function errorForResult(result: RideCodexTurnResult, snapshot: RideCodexControlSnapshot): RideCodexMappedError {
    if (result.status === 'interrupt-uncertain') {
        return mapRideCodexError('interrupted');
    }
    return errorForSnapshot(snapshot);
}

function safeWarning(code: string): string {
    switch (code) {
        case 'events-dropped': return 'Some response events were dropped.';
        case 'data-truncated': return 'Some response data was truncated.';
        default: return 'The response contains a recoverable diagnostic.';
    }
}

function renderFileChanges(model: ReturnType<typeof createRideCodexFileRenderModel>): string {
    if (!model) {
        return '';
    }
    const lines = ['\n**Codex file changes**'];
    for (const change of model.changes) {
        const label = change.operation === 'move'
            ? `${change.operation} ${escapeMarkdown(change.fromPath)} → ${escapeMarkdown(change.toPath)}`
            : `${change.operation} ${escapeMarkdown(change.path)}`;
        lines.push(`- ${label}`);
        if (change.diff) {
            lines.push(codeFence(change.diff, 'diff'));
        }
    }
    if (model.truncation.truncated) {
        lines.push(`_Some file changes were truncated (${model.truncation.omittedChanges} omitted)._`);
    }
    return `${lines.join('\n')}\n`;
}

function codeFence(value: string, language: string): string {
    const safe = value.split('```').join('` ` `');
    return `\`\`\`${language}\n${safe}\n\`\`\``;
}

function escapeMarkdown(value: string): string {
    return value.replace(/[\\`<>]/g, character => `\\${character}`);
}
