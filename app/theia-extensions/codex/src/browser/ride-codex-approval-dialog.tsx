/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from '@theia/core/shared/react';
import {
    RideCodexApprovalCard,
    RideCodexApprovalDecision
} from '../common/ride-codex-approvals';

export interface RideCodexApprovalDialogState {
    readonly approval?: RideCodexApprovalCard;
    readonly busy: boolean;
}

export interface RideCodexApprovalDialogProps {
    readonly state: RideCodexApprovalDialogState;
    readonly onDecision: (decision: RideCodexApprovalDecision) => void;
}

const DECISION_LABELS: Readonly<Record<RideCodexApprovalDecision, string>> = Object.freeze({
    accept: 'Allow once',
    acceptForSession: 'Allow for session',
    decline: 'Decline',
    cancel: 'Cancel'
});
const STABLE_DECISIONS = Object.freeze([
    'accept', 'acceptForSession', 'decline', 'cancel'
] as const);

export function RideCodexApprovalDialog(
    props: RideCodexApprovalDialogProps
): React.ReactElement | undefined {
    const approval = props.state.approval;
    if (!approval) {
        return undefined;
    }
    const decisions = STABLE_DECISIONS.filter(decision => approval.allowedDecisions.includes(decision));
    return <section className='ride-codex-approval' aria-label='Codex approval request'>
        <h3>{approval.kind === 'command' ? 'Review command' : 'Review file changes'}</h3>
        {approval.kind === 'command' ? <div className='ride-codex-approval-command'>
            <pre>{approval.command}</pre>
            {approval.cwd === undefined ? undefined : <div><span>Working directory</span><code>{approval.cwd}</code></div>}
            {approval.reason === undefined ? undefined : <p>{approval.reason}</p>}
            {approval.network === undefined ? undefined : <div>
                <span>Network</span>
                <code>{approval.network.protocol}</code>
                <code>{approval.network.host}</code>
            </div>}
        </div> : <div className='ride-codex-approval-files'>
            <ul>{approval.changes.map((change, index) => <li key={`${index}:${change.path}`}>
                <span>{change.kind}</span>
                <code>{change.path}</code>
                {change.movePath === undefined ? undefined : <><span>to</span><code>{change.movePath}</code></>}
            </li>)}</ul>
            {approval.reason === undefined ? undefined : <p>{approval.reason}</p>}
        </div>}
        <div className='ride-codex-approval-actions'>
            {decisions.map(decision => <button
                type='button'
                key={decision}
                data-decision={decision}
                disabled={props.state.busy}
                onClick={() => props.onDecision(decision)}
            >{DECISION_LABELS[decision]}</button>)}
        </div>
    </section>;
}
