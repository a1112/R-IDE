/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { interfaces } from '@theia/core/shared/inversify';
import {
    bindReplacementSingleton,
    shouldInitializeDefaultTerminal
} from '../src/browser/ride-terminal-startup';

class UpstreamTerminalContribution { }
class RideTerminalContribution extends UpstreamTerminalContribution { }

test('default terminal remains enabled in a regular browser', () => {
    assert.equal(shouldInitializeDefaultTerminal({}, () => false), true);
});

test('default terminal is disabled by the explicit compatibility flag', () => {
    assert.equal(shouldInitializeDefaultTerminal({ RIDE_DISABLE_DEFAULT_TERMINAL: true }, () => false), false);
});

test('default terminal is disabled when the Tauri runtime is detected', () => {
    assert.equal(shouldInitializeDefaultTerminal({}, () => true), false);
});

test('terminal binding replaces Theia contribution with the R-IDE singleton', () => {
    const calls: string[] = [];
    let target: unknown;
    const syntax = {
        to: (implementation: unknown) => {
            target = implementation;
            return {
                inSingletonScope: () => {
                    calls.push('singleton');
                }
            };
        }
    };
    const bind = (() => {
        calls.push('bind');
        return syntax;
    }) as unknown as interfaces.Bind;
    const rebind = (() => {
        calls.push('rebind');
        return syntax;
    }) as unknown as interfaces.Bind;

    bindReplacementSingleton(
        bind,
        () => true,
        rebind,
        UpstreamTerminalContribution,
        RideTerminalContribution
    );

    assert.deepEqual(calls, ['rebind', 'singleton']);
    assert.strictEqual(target, RideTerminalContribution);
    assert.notStrictEqual(target, UpstreamTerminalContribution);
});

test('terminal binding can initialize before the upstream terminal module', () => {
    const calls: string[] = [];
    const syntax = {
        to: () => ({
            inSingletonScope: () => {
                calls.push('singleton');
            }
        })
    };
    const bind = (() => {
        calls.push('bind');
        return syntax;
    }) as unknown as interfaces.Bind;
    const rebind = (() => {
        calls.push('rebind');
        return syntax;
    }) as unknown as interfaces.Bind;

    bindReplacementSingleton(
        bind,
        () => false,
        rebind,
        UpstreamTerminalContribution,
        RideTerminalContribution
    );

    assert.deepEqual(calls, ['bind', 'singleton']);
});

test('terminal replacement is installed by the product frontend module', async () => {
    const moduleSource = await readFile(
        resolve(process.cwd(), 'src/browser/theia-ide-frontend-module.ts'),
        'utf8'
    );
    assert.match(moduleSource, /bindRideTerminalFrontendContribution\(bind,\s*isBound,\s*rebind\)/);
});
