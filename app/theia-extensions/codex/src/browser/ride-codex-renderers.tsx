/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from '@theia/core/shared/react';
import {
    deepFreezeRideCodex,
    RideCodexRenderedItem,
    truncateUtf8,
    utf8ByteLength
} from '../common/ride-codex-events';
import { isRideCodexReducerItem } from './ride-codex-event-reducer';

export interface RideCodexRenderTruncationModel {
    readonly truncated: boolean;
    readonly omittedUtf8Bytes: number;
    readonly omittedChanges: number;
    readonly omittedPaths: number;
}

export interface RideCodexCommandRenderModel {
    readonly kind: 'command';
    readonly output: string;
    readonly truncation: RideCodexRenderTruncationModel;
}

export type RideCodexFileRenderChange =
    | Readonly<{ operation: 'add' | 'delete' | 'update'; path: string; diff: string }>
    | Readonly<{ operation: 'move'; fromPath: string; toPath: string; diff: string }>;

export interface RideCodexFileRenderModel {
    readonly kind: 'file-change';
    readonly changes: readonly RideCodexFileRenderChange[];
    readonly truncation: RideCodexRenderTruncationModel;
}

export interface RideCodexCommandRenderOptions {
    readonly maxOutputBytes?: number;
}

export interface RideCodexFileRenderOptions {
    readonly maxChanges?: number;
    readonly maxPathBytes?: number;
    readonly maxPatchBytes?: number;
    readonly maxTotalBytes?: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_CHANGES = 256;
const DEFAULT_MAX_PATH_BYTES = 32 * 1024;
const DEFAULT_MAX_PATCH_BYTES = 64 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024;

export function createRideCodexCommandRenderModel(
    item: RideCodexRenderedItem,
    options: RideCodexCommandRenderOptions = {}
): RideCodexCommandRenderModel | undefined {
    if (!isReducerItem(item, 'command')) {
        return undefined;
    }
    const maxOutputBytes = renderLimit(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
    const output = truncateUtf8(item.text, maxOutputBytes);
    const source = item.truncation;
    const omittedUtf8Bytes = saturatingAdd(
        source?.omittedUtf8Bytes ?? 0,
        utf8ByteLength(item.text) - utf8ByteLength(output)
    );
    return deepFreezeRideCodex({
        kind: 'command',
        output,
        truncation: {
            truncated: omittedUtf8Bytes > 0
                || (source?.omittedChanges ?? 0) > 0
                || (source?.omittedPaths ?? 0) > 0,
            omittedUtf8Bytes,
            omittedChanges: source?.omittedChanges ?? 0,
            omittedPaths: source?.omittedPaths ?? 0
        }
    });
}

export function createRideCodexFileRenderModel(
    item: RideCodexRenderedItem,
    options: RideCodexFileRenderOptions = {}
): RideCodexFileRenderModel | undefined {
    if (!isReducerItem(item, 'file-change')) {
        return undefined;
    }
    const maxChanges = renderLimit(options.maxChanges, DEFAULT_MAX_CHANGES);
    const maxPathBytes = renderLimit(options.maxPathBytes, DEFAULT_MAX_PATH_BYTES);
    const maxPatchBytes = renderLimit(options.maxPatchBytes, DEFAULT_MAX_PATCH_BYTES);
    const maxTotalBytes = renderLimit(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
    const changes: RideCodexFileRenderChange[] = [];
    let retainedBytes = 0;
    let retainedSourceBytes = 0;
    let omittedPaths = item.truncation?.omittedPaths ?? 0;
    const sourceBytes = item.changes.reduce((total, change) => total
        + utf8ByteLength(change.path)
        + utf8ByteLength(change.diff)
        + (change.kind === 'update' && typeof change.movePath === 'string'
            ? utf8ByteLength(change.movePath) : 0), 0);

    for (let index = 0; index < item.changes.length && index < maxChanges; index += 1) {
        const source = item.changes[index];
        const sourceMovePath = source.kind === 'update' ? source.movePath : undefined;
        const path = truncateUtf8(source.path, maxPathBytes);
        const diff = truncateUtf8(source.diff, maxPatchBytes);
        const movePath = typeof sourceMovePath === 'string'
            ? truncateUtf8(sourceMovePath, maxPathBytes) : undefined;
        const candidateBytes = utf8ByteLength(path) + utf8ByteLength(diff)
            + (movePath === undefined ? 0 : utf8ByteLength(movePath));
        if (retainedBytes + candidateBytes > maxTotalBytes) {
            break;
        }
        retainedBytes += candidateBytes;
        retainedSourceBytes += utf8ByteLength(source.path) + utf8ByteLength(source.diff)
            + (source.kind === 'update' && typeof source.movePath === 'string'
                ? utf8ByteLength(source.movePath) : 0);
        if (path !== source.path) {
            omittedPaths += 1;
        }
        if (movePath !== undefined && movePath !== sourceMovePath) {
            omittedPaths += 1;
        }
        changes.push(source.kind === 'update' && movePath !== undefined
            ? Object.freeze({ operation: 'move', fromPath: path, toPath: movePath, diff })
            : Object.freeze({ operation: source.kind, path, diff }));
    }

    const omittedChanges = saturatingAdd(
        item.truncation?.omittedChanges ?? 0,
        item.changes.length - changes.length
    );
    const retainedOriginal = item.changes.slice(0, changes.length).reduce((total, change) => total
        + utf8ByteLength(change.path)
        + utf8ByteLength(change.diff)
        + (change.kind === 'update' && typeof change.movePath === 'string'
            ? utf8ByteLength(change.movePath) : 0), 0);
    const omittedUtf8Bytes = saturatingAdd(
        item.truncation?.omittedUtf8Bytes ?? 0,
        sourceBytes - retainedOriginal + retainedSourceBytes - retainedBytes
    );
    return deepFreezeRideCodex({
        kind: 'file-change',
        changes,
        truncation: {
            truncated: omittedUtf8Bytes > 0 || omittedChanges > 0 || omittedPaths > 0,
            omittedUtf8Bytes,
            omittedChanges,
            omittedPaths
        }
    });
}

export function RideCodexCommandOutput(
    props: Readonly<{ model: RideCodexCommandRenderModel }>
): React.ReactElement {
    return <section className='ride-codex-command-output'>
        <pre>{props.model.output}</pre>
        {props.model.truncation.truncated
            ? <p>Output truncated ({props.model.truncation.omittedUtf8Bytes} UTF-8 bytes omitted).</p>
            : undefined}
    </section>;
}

export function RideCodexFileChanges(
    props: Readonly<{ model: RideCodexFileRenderModel }>
): React.ReactElement {
    return <section className='ride-codex-file-changes'>
        <ul>{props.model.changes.map((change, index) => <li key={index}>
            <span>{change.operation}</span>
            {change.operation === 'move' ? <>
                <code>{change.fromPath}</code><span>to</span><code>{change.toPath}</code>
            </> : <code>{change.path}</code>}
            <pre>{change.diff}</pre>
        </li>)}</ul>
        {props.model.truncation.truncated ? <p>
            File changes truncated ({props.model.truncation.omittedChanges} changes omitted).
        </p> : undefined}
    </section>;
}

function isReducerItem(
    item: RideCodexRenderedItem,
    kind: RideCodexRenderedItem['kind']
): boolean {
    return isRideCodexReducerItem(item) && item.kind === kind;
}

function renderLimit(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fallback;
}

function saturatingAdd(left: number, right: number): number {
    return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, left) + Math.max(0, right));
}
