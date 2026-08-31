/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { MessageService } from '@theia/core/lib/common/message-service';
import { PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import type { interfaces } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import type {
    RideCodexSmokeAction,
    RideSmokePlan
} from 'theia-ide-product-ext/lib/browser/ride-packaged-smoke';
import {
    RideCodexAuthClientRelay,
    RideCodexAuthController
} from 'theia-ide-codex-ext/lib/browser/ride-codex-auth-controller';
import { RideCodexChatAgent } from 'theia-ide-codex-ext/lib/browser/ride-codex-chat-agent';
import {
    RideCodexControlModel,
    RideCodexControlServices
} from 'theia-ide-codex-ext/lib/browser/ride-codex-control-model';
import { RideCodexContribution } from 'theia-ide-codex-ext/lib/browser/ride-codex-contribution';
import {
    RideCodexApprovalClient,
    RideCodexApprovalsService,
    RideCodexApprovalsServicePath,
    RideCodexAuthService,
    RideCodexAuthServicePath,
    RideCodexConversationsClient,
    RideCodexConversationsService,
    RideCodexConversationsServicePath,
    RideCodexTurnClient,
    RideCodexTurnsService,
    RideCodexTurnsServicePath
} from 'theia-ide-codex-ext/lib/common/ride-codex-protocol';

export interface RideCodexFeatureSmoke {
    run(action: RideCodexSmokeAction, plan: RideSmokePlan): Promise<void>;
}

export function createCodexFeature(container: interfaces.Container) {
    const authRelay = new RideCodexAuthClientRelay();
    let model: RideCodexControlModel | undefined;
    let disposed = false;

    const auth = WebSocketConnectionProvider.createProxy<RideCodexAuthService>(
        container,
        RideCodexAuthServicePath,
        authRelay
    );
    const conversationsClient: RideCodexConversationsClient = {
        conversationsChanged: snapshot => model?.conversationsChanged(snapshot)
    };
    const turnClient: RideCodexTurnClient = {
        turnEvents: wire => model?.notifyTurnEvents(wire)
    };
    const approvalClient: RideCodexApprovalClient = {
        approvalsChanged: approvals => model?.approvalsChanged(approvals)
    };
    const conversations = WebSocketConnectionProvider.createProxy<RideCodexConversationsService>(
        container,
        RideCodexConversationsServicePath,
        conversationsClient
    );
    const turns = WebSocketConnectionProvider.createProxy<RideCodexTurnsService>(
        container,
        RideCodexTurnsServicePath,
        turnClient
    );
    const approvals = WebSocketConnectionProvider.createProxy<RideCodexApprovalsService>(
        container,
        RideCodexApprovalsServicePath,
        approvalClient
    );

    const preferences = container.get<PreferenceService>(PreferenceService);
    const messages = container.get(MessageService);
    const authController = new RideCodexAuthController({
        auth,
        relay: authRelay,
        preferences: {
            read: name => preferences.get(name),
            remove: async (name, expectedValue) => {
                if (preferences.get(name) !== expectedValue) {
                    return false;
                }
                await preferences.updateValue(name, undefined);
                return preferences.get(name) === undefined;
            }
        },
        prompt: {
            confirmLegacyApiKeyMigration: async sources => {
                const action = await messages.info(
                    `R-IDE found legacy Codex API key settings in: ${sources.join(', ')}. Migrate them to Codex authentication?`,
                    'Migrate',
                    'Keep for manual handling'
                );
                return action === 'Migrate';
            }
        }
    });

    const workspace = container.get<WorkspaceService>(WorkspaceService);
    const workspaceRoot = () => workspace.tryGetRoots()[0]?.resource.path.fsPath() ?? '';
    const services: RideCodexControlServices = { auth, conversations, turns, approvals };
    model = new RideCodexControlModel({
        services,
        workspaceRoot
    });
    const authAttachment = authRelay.attach(model);
    const contribution = new RideCodexContribution(
        container.get<ApplicationShell>(ApplicationShell),
        model
    );
    const agent = new RideCodexChatAgent(model);

    const requireModel = (): RideCodexControlModel => {
        if (!model) {
            throw new Error('Codex control model is unavailable.');
        }
        return model;
    };
    const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
        const deadline = Date.now() + Math.max(100, Math.min(timeoutMs, 10_000));
        while (!predicate()) {
            if (Date.now() >= deadline) {
                throw new Error('Codex packaged smoke condition timed out.');
            }
            await new Promise<void>(resolve => globalThis.setTimeout(resolve, 25));
        }
    };
    const ensureReady = async (plan: RideSmokePlan): Promise<RideCodexControlModel> => {
        const control = requireModel();
        await waitFor(() => control.snapshot().phase === 'ready', plan.actionTimeoutMs);
        return control;
    };
    const runApproval = async (
        kind: 'command' | 'file-change',
        prompt: string,
        plan: RideSmokePlan
    ): Promise<void> => {
        const control = await ensureReady(plan);
        const pending = control.submitTurn(prompt);
        try {
            await waitFor(() => control.snapshot().approvals.some(approval => approval.kind === kind), plan.actionTimeoutMs);
            const card = control.snapshot().approvals.find(approval => approval.kind === kind);
            if (!card) {
                throw new Error('Codex packaged smoke approval is unavailable.');
            }
            const decision = await control.decideApproval(card, 'accept');
            if (decision.status !== 'responded') {
                throw new Error('Codex packaged smoke approval was not accepted.');
            }
            const result = await pending;
            if (result.status !== 'completed') {
                throw new Error('Codex packaged smoke approval turn did not complete.');
            }
        } catch (error) {
            await pending.catch(() => undefined);
            throw error;
        }
    };
    const smoke: RideCodexFeatureSmoke = Object.freeze({
        run: async (action, plan) => {
            switch (action) {
                case 'codex-inactive':
                    throw new Error('Codex smoke inactive action must run before feature activation.');
                case 'codex-activate': {
                    const control = await ensureReady(plan);
                    if (control.snapshot().models.length === 0) {
                        throw new Error('Codex packaged smoke model list is empty.');
                    }
                    return;
                }
                case 'codex-stream': {
                    const result = await (await ensureReady(plan)).submitTurn('codex smoke stream');
                    if (result.status !== 'completed') {
                        throw new Error('Codex packaged smoke stream did not complete.');
                    }
                    return;
                }
                case 'codex-command-approval':
                    return runApproval('command', 'codex smoke command approval', plan);
                case 'codex-file-approval':
                    return runApproval('file-change', 'codex smoke file approval', plan);
                case 'codex-interrupt': {
                    const control = await ensureReady(plan);
                    const pending = control.submitTurn('codex smoke interrupt');
                    try {
                        await waitFor(() => control.snapshot().turn.status === 'in-progress', plan.actionTimeoutMs);
                        const interrupted = await control.interruptTurn();
                        const submitted = await pending;
                        if (!['interrupted', 'interrupt-uncertain'].includes(interrupted.status)
                            || !['interrupted', 'interrupt-uncertain'].includes(submitted.status)) {
                            throw new Error('Codex packaged smoke interrupt was not confirmed.');
                        }
                    } catch (error) {
                        await pending.catch(() => undefined);
                        throw error;
                    }
                    return;
                }
                case 'codex-recover': {
                    const control = await ensureReady(plan);
                    const crashed = await control.submitTurn('codex smoke recover').then(
                        result => result.status === 'failed' ? undefined : result,
                        () => undefined
                    );
                    if (crashed !== undefined) {
                        throw new Error('Codex packaged smoke recovery did not observe the fixture crash.');
                    }
                    for (let attempt = 0; attempt < 3; attempt += 1) {
                        await control.retry();
                        if (control.snapshot().phase === 'ready') {
                            return;
                        }
                    }
                    throw new Error('Codex packaged smoke recovery did not restore the ready state.');
                }
                case 'codex-idle-exit': {
                    const control = requireModel();
                    await control.dispose();
                    authController.dispose();
                    await new Promise<void>(resolve => globalThis.setTimeout(resolve, 350));
                    return;
                }
            }
        }
    });

    return {
        agent,
        smoke,
        activate: async () => {
            if (disposed) {
                throw new Error('Codex feature is disposed.');
            }
            await authController.activate();
            await model?.initialize();
        },
        open: async () => {
            if (disposed) {
                throw new Error('Codex feature is disposed.');
            }
            await contribution.open();
        },
        dispose: () => {
            if (disposed) {
                return;
            }
            disposed = true;
            authAttachment.dispose();
            authController.dispose();
            model?.dispose().catch(() => undefined);
            contribution.dispose();
        }
    };
}
