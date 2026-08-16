/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export interface RideUsageGroup {
    cpuPercent: number;
    memoryBytes: number;
    processCount: number;
}

export interface RidePerformanceSnapshot {
    sampledAtMs: number;
    total: RideUsageGroup;
    main: RideUsageGroup;
    backend: RideUsageGroup;
    pluginHost: RideUsageGroup;
    other: RideUsageGroup;
}

export interface PerformanceViewState {
    available: boolean;
    text: string;
    tooltip: string;
}

export interface RidePerformancePollerOptions {
    fetchSnapshot: () => Promise<RidePerformanceSnapshot>;
    onUpdate: (state: PerformanceViewState) => void;
    setInterval: (handler: () => void, delay: number) => unknown;
    clearInterval: (handle: unknown) => void;
    locale?: string;
}

const PERFORMANCE_POLL_INTERVAL_MS = 2_000;
const FAILURE_THRESHOLD = 3;

function formatUnitValue(value: number): string {
    const precision = value < 10 ? 1 : 0;
    return value.toFixed(precision).replace(/\.0$/, '');
}

export function formatBytes(bytes: number): string {
    const normalizedBytes = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = normalizedBytes;
    let unitIndex = 0;

    while (value >= 1_024 && unitIndex < units.length - 1) {
        value /= 1_024;
        unitIndex++;
    }

    if (unitIndex === 0) {
        return `${Math.round(value)} ${units[unitIndex]}`;
    }
    return `${formatUnitValue(value)} ${units[unitIndex]}`;
}

function formatCpu(cpuPercent: number): string {
    const normalizedCpu = Number.isFinite(cpuPercent) ? Math.max(0, cpuPercent) : 0;
    return `${normalizedCpu.toFixed(1)}%`;
}

function isChinese(locale: string): boolean {
    return locale.toLowerCase().startsWith('zh');
}

function formatGroup(
    label: string,
    group: RideUsageGroup,
    memoryLabel: string,
    processLabel: (count: number) => string
): string {
    return `${label}  CPU ${formatCpu(group.cpuPercent)}  ${memoryLabel} ${formatBytes(group.memoryBytes)}`
        + `  ${processLabel(group.processCount)}`;
}

export function formatPerformanceSnapshot(
    snapshot: RidePerformanceSnapshot,
    locale = 'en'
): PerformanceViewState {
    const chinese = isChinese(locale);
    const memoryLabel = chinese ? '内存' : 'Memory';
    const labels = chinese
        ? ['R-IDE 总计', '主进程', '后端', '插件宿主', '其他']
        : ['R-IDE Total', 'Main', 'Backend', 'Plugin Host', 'Other'];
    const processLabel = chinese
        ? (count: number): string => `${count} 个进程`
        : (count: number): string => `${count} ${count === 1 ? 'process' : 'processes'}`;
    const groups = [snapshot.total, snapshot.main, snapshot.backend, snapshot.pluginHost, snapshot.other];

    return {
        available: true,
        text: `$(pulse) CPU ${formatCpu(snapshot.total.cpuPercent)}  ${memoryLabel} ${formatBytes(snapshot.total.memoryBytes)}`,
        tooltip: groups.map((group, index) => formatGroup(labels[index], group, memoryLabel, processLabel)).join('\n')
    };
}

function unavailableView(locale: string): PerformanceViewState {
    if (isChinese(locale)) {
        return {
            available: false,
            text: '$(pulse) 性能数据不可用',
            tooltip: 'R-IDE 性能数据暂不可用'
        };
    }
    return {
        available: false,
        text: '$(pulse) Performance unavailable',
        tooltip: 'R-IDE performance data is temporarily unavailable'
    };
}

export class RidePerformancePoller {
    protected readonly locale: string;
    protected intervalHandle: unknown;
    protected started = false;
    protected disposed = false;
    protected requestInFlight = false;
    protected consecutiveFailures = 0;
    protected lastSuccessfulView: PerformanceViewState | undefined;

    constructor(protected readonly options: RidePerformancePollerOptions) {
        this.locale = options.locale ?? 'en';
    }

    start(): void {
        if (this.started || this.disposed) {
            return;
        }
        this.started = true;
        this.intervalHandle = this.options.setInterval(() => {
            void this.refresh();
        }, PERFORMANCE_POLL_INTERVAL_MS);
        void this.refresh();
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.started) {
            this.options.clearInterval(this.intervalHandle);
        }
    }

    protected async refresh(): Promise<void> {
        if (this.disposed || this.requestInFlight) {
            return;
        }
        this.requestInFlight = true;
        try {
            const snapshot = await this.options.fetchSnapshot();
            if (this.disposed) {
                return;
            }
            const view = formatPerformanceSnapshot(snapshot, this.locale);
            this.consecutiveFailures = 0;
            this.lastSuccessfulView = view;
            this.options.onUpdate(view);
        } catch {
            if (this.disposed) {
                return;
            }
            this.consecutiveFailures++;
            if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
                this.options.onUpdate(unavailableView(this.locale));
            } else if (this.lastSuccessfulView) {
                this.options.onUpdate(this.lastSuccessfulView);
            }
        } finally {
            this.requestInFlight = false;
        }
    }
}
