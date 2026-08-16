/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar-types';
import { Disposable } from '@theia/core/lib/common/disposable';
import { inject, injectable, interfaces } from '@theia/core/shared/inversify';
import { getStoredRideLanguage, RideLanguage, RideNativeChrome } from './ride-native-chrome';
import { PerformanceViewState, RidePerformancePoller } from './ride-performance';

const RIDE_PERFORMANCE_STATUS_BAR_ID = 'ride-performance';

export function bindRidePerformanceContribution(bind: interfaces.Bind): void {
    bind(RidePerformanceContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(RidePerformanceContribution);
}

@injectable()
export class RidePerformanceContribution implements FrontendApplicationContribution, Disposable {
    protected started = false;
    protected disposed = false;
    protected statusBarTouched = false;
    protected locale: RideLanguage = 'en';
    protected poller: RidePerformancePoller | undefined;

    constructor(
        @inject(StatusBar) protected readonly statusBar: StatusBar,
        @inject(FrontendApplicationStateService) protected readonly applicationState: FrontendApplicationStateService,
        @inject(RideNativeChrome) protected readonly nativeChrome: RideNativeChrome
    ) { }

    onStart(): void {
        if (this.started || this.disposed) {
            return;
        }
        this.started = true;
        if (!this.nativeChrome.isTauri) {
            return;
        }
        this.locale = getStoredRideLanguage();
        this.startAfterReady().catch(error => {
            console.warn('[R-IDE] Failed to start performance reporting.', error);
        });
    }

    protected async startAfterReady(): Promise<void> {
        await this.applicationState.reachedState('ready');
        if (this.disposed || this.poller) {
            return;
        }
        this.poller = new RidePerformancePoller({
            fetchSnapshot: async () => {
                const snapshot = await this.nativeChrome.getPerformanceSnapshot();
                if (!snapshot) {
                    throw new Error('R-IDE native performance snapshot was unexpectedly unavailable.');
                }
                return snapshot;
            },
            onUpdate: state => this.updateStatusBar(state),
            setInterval: (handler, delay) => globalThis.setInterval(handler, delay),
            clearInterval: handle => globalThis.clearInterval(handle as number),
            locale: this.locale
        });
        this.poller.start();
    }

    protected async updateStatusBar(state: PerformanceViewState): Promise<void> {
        const name = this.locale === 'zh-cn' ? 'R-IDE 性能' : 'R-IDE Performance';
        const summary = state.text.replace(/^\$\(pulse\)\s*/, '').replace(/\s{2,}/g, ', ');
        this.statusBarTouched = true;
        await this.statusBar.setElement(RIDE_PERFORMANCE_STATUS_BAR_ID, {
            name,
            text: state.text,
            tooltip: state.tooltip,
            alignment: StatusBarAlignment.RIGHT,
            priority: 5,
            accessibilityInformation: {
                label: `${name}: ${summary}`,
                role: 'status'
            }
        });
        if (this.disposed) {
            this.removeStatusBar();
        }
    }

    onStop(): void {
        this.dispose();
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.poller?.dispose();
        this.poller = undefined;
        if (this.statusBarTouched) {
            this.removeStatusBar();
        }
    }

    protected removeStatusBar(): void {
        try {
            this.statusBar.removeElement(RIDE_PERFORMANCE_STATUS_BAR_ID).catch(error => {
                console.warn('[R-IDE] Failed to remove performance status.', error);
            });
        } catch (error) {
            console.warn('[R-IDE] Failed to remove performance status.', error);
        }
    }
}
