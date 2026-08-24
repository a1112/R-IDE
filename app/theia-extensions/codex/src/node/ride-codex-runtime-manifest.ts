/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createHash } from 'node:crypto';

export const RIDE_CODEX_RUNTIME_VERSION = '0.144.0' as const;

export type RuntimeTarget =
    | 'x86_64-pc-windows-msvc'
    | 'aarch64-pc-windows-msvc'
    | 'x86_64-apple-darwin'
    | 'aarch64-apple-darwin'
    | 'x86_64-unknown-linux-musl'
    | 'aarch64-unknown-linux-musl';

export interface RideCodexRuntimeManifestEntry {
    readonly package: '@openai/codex';
    readonly version: typeof RIDE_CODEX_RUNTIME_VERSION;
    readonly npmVersion: string;
    readonly target: RuntimeTarget;
    readonly url: string;
    readonly integrity: string;
    readonly compressedBytes: number;
    readonly unpackedBytes: number;
    readonly layoutVersion: 1;
    readonly entrypoint: 'bin/codex.exe' | 'bin/codex';
}

export interface RideCodexRuntimeManifest {
    readonly schemaVersion: 1;
    readonly runtimes: readonly RideCodexRuntimeManifestEntry[];
}

interface TargetMetadata {
    readonly npmSuffix: string;
    readonly entrypoint: RideCodexRuntimeManifestEntry['entrypoint'];
}

const TARGET_METADATA: Readonly<Record<RuntimeTarget, TargetMetadata>> = Object.freeze({
    'x86_64-pc-windows-msvc': Object.freeze({ npmSuffix: 'win32-x64', entrypoint: 'bin/codex.exe' }),
    'aarch64-pc-windows-msvc': Object.freeze({ npmSuffix: 'win32-arm64', entrypoint: 'bin/codex.exe' }),
    'x86_64-apple-darwin': Object.freeze({ npmSuffix: 'darwin-x64', entrypoint: 'bin/codex' }),
    'aarch64-apple-darwin': Object.freeze({ npmSuffix: 'darwin-arm64', entrypoint: 'bin/codex' }),
    'x86_64-unknown-linux-musl': Object.freeze({ npmSuffix: 'linux-x64', entrypoint: 'bin/codex' }),
    'aarch64-unknown-linux-musl': Object.freeze({ npmSuffix: 'linux-arm64', entrypoint: 'bin/codex' })
});

const RUNTIME_KEYS = Object.freeze([
    'package', 'version', 'npmVersion', 'target', 'url', 'integrity',
    'compressedBytes', 'unpackedBytes', 'layoutVersion', 'entrypoint'
].sort());

const RAW_MANIFEST: unknown = {
    schemaVersion: 1,
    runtimes: [
        {
            package: '@openai/codex', version: '0.144.0', npmVersion: '0.144.0-win32-x64',
            target: 'x86_64-pc-windows-msvc',
            url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.144.0-win32-x64.tgz',
            integrity: 'sha512-QiholLCYqNeYvNM77HOmPtrOFrY0rQc/N9nXt+sQGXO3rEGmcWjpLzujY4Oegl3CLRHoieWqlep3EqEvFBjoIA==',
            compressedBytes: 145137410, unpackedBytes: 409204884, layoutVersion: 1, entrypoint: 'bin/codex.exe'
        },
        {
            package: '@openai/codex', version: '0.144.0', npmVersion: '0.144.0-win32-arm64',
            target: 'aarch64-pc-windows-msvc',
            url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.144.0-win32-arm64.tgz',
            integrity: 'sha512-e2yGSgwdzrT1SoJMoOzWD58WBEsIaAMZpEchuV2VGkE2T955SG7dn7EyVQTQcy7/rdpE8aEDktZ/1eQQfjkdtQ==',
            compressedBytes: 136015165, unpackedBytes: 356429977, layoutVersion: 1, entrypoint: 'bin/codex.exe'
        },
        {
            package: '@openai/codex', version: '0.144.0', npmVersion: '0.144.0-darwin-x64',
            target: 'x86_64-apple-darwin',
            url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.144.0-darwin-x64.tgz',
            integrity: 'sha512-4p2jxRbN+Khg5UQzpkzT9upFj+qkEF/abmdvrtflkkWmVKP6Nt+yi8ospdqv9PDqvQ9SotPvX7iXaFaeUTrtmA==',
            compressedBytes: 128742068, unpackedBytes: 337146266, layoutVersion: 1, entrypoint: 'bin/codex'
        },
        {
            package: '@openai/codex', version: '0.144.0', npmVersion: '0.144.0-darwin-arm64',
            target: 'aarch64-apple-darwin',
            url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.144.0-darwin-arm64.tgz',
            integrity: 'sha512-rqFAJdOa2I0VRgepVsSZeLxs96+Y+LXTjccOOvH6894FyaFAYPZ/o+6hgpB1iGHxxdoY/DsGa8jrJC8Leqn9Kg==',
            compressedBytes: 120229260, unpackedBytes: 311534939, layoutVersion: 1, entrypoint: 'bin/codex'
        },
        {
            package: '@openai/codex', version: '0.144.0', npmVersion: '0.144.0-linux-x64',
            target: 'x86_64-unknown-linux-musl',
            url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.144.0-linux-x64.tgz',
            integrity: 'sha512-GmKtQeX+cO9lN7mQD1FEVcXYEMLMgMByHwZdvlluH0bj/+c2ind3hwbRtE3eECFDekNhEiB80Ez0FfbkyFQqoA==',
            compressedBytes: 131150753, unpackedBytes: 351492154, layoutVersion: 1, entrypoint: 'bin/codex'
        },
        {
            package: '@openai/codex', version: '0.144.0', npmVersion: '0.144.0-linux-arm64',
            target: 'aarch64-unknown-linux-musl',
            url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.144.0-linux-arm64.tgz',
            integrity: 'sha512-k++xhZrn9P3laO00Q92APG6mdOFDD66nUBo+8ExCa1NXi2pjLEMLC4+UNJTUUtUT1PEflOZ5pDKxPXgzaiFFFg==',
            compressedBytes: 123658222, unpackedBytes: 308463407, layoutVersion: 1, entrypoint: 'bin/codex'
        }
    ]
};

export const RIDE_CODEX_RUNTIME_MANIFEST = parseRideCodexRuntimeManifest(RAW_MANIFEST);

export function parseRideCodexRuntimeManifest(value: unknown): RideCodexRuntimeManifest {
    try {
        const root = requireDataRecord(value, ['runtimes', 'schemaVersion']);
        if (root.schemaVersion !== 1 || !Array.isArray(root.runtimes) || root.runtimes.length !== 6) {
            throw new Error('shape');
        }
        const targets = new Set<RuntimeTarget>();
        const runtimes = root.runtimes.map(candidate => {
            const runtime = requireDataRecord(candidate, RUNTIME_KEYS);
            if (runtime.package !== '@openai/codex'
                || runtime.version !== RIDE_CODEX_RUNTIME_VERSION
                || runtime.layoutVersion !== 1
                || typeof runtime.target !== 'string'
                || !Object.prototype.hasOwnProperty.call(TARGET_METADATA, runtime.target)) {
                throw new Error('identity');
            }
            const target = runtime.target as RuntimeTarget;
            if (targets.has(target)) {
                throw new Error('duplicate');
            }
            targets.add(target);
            const targetMetadata = TARGET_METADATA[target];
            const npmVersion = `${RIDE_CODEX_RUNTIME_VERSION}-${targetMetadata.npmSuffix}`;
            const url = `https://registry.npmjs.org/@openai/codex/-/codex-${npmVersion}.tgz`;
            if (runtime.npmVersion !== npmVersion || runtime.url !== url
                || runtime.entrypoint !== targetMetadata.entrypoint
                || !isPositiveSafeInteger(runtime.compressedBytes)
                || !isPositiveSafeInteger(runtime.unpackedBytes)
                || !isValidSha512Integrity(runtime.integrity)) {
                throw new Error('metadata');
            }
            const parsedUrl = new URL(runtime.url as string);
            if (parsedUrl.protocol !== 'https:' || parsedUrl.origin !== 'https://registry.npmjs.org'
                || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
                throw new Error('url');
            }
            return Object.freeze({
                package: '@openai/codex' as const,
                version: RIDE_CODEX_RUNTIME_VERSION,
                npmVersion,
                target,
                url,
                integrity: runtime.integrity as string,
                compressedBytes: runtime.compressedBytes as number,
                unpackedBytes: runtime.unpackedBytes as number,
                layoutVersion: 1 as const,
                entrypoint: targetMetadata.entrypoint
            });
        });
        if (targets.size !== Object.keys(TARGET_METADATA).length) {
            throw new Error('targets');
        }
        return Object.freeze({ schemaVersion: 1, runtimes: Object.freeze(runtimes) });
    } catch {
        throw new Error('Codex runtime manifest is invalid.');
    }
}

export function runtimeManifestEntryForTarget(target: RuntimeTarget): RideCodexRuntimeManifestEntry {
    const runtime = RIDE_CODEX_RUNTIME_MANIFEST.runtimes.find(entry => entry.target === target);
    if (!runtime) {
        throw new Error('Codex runtime target is not present in the reviewed manifest.');
    }
    return runtime;
}

export function runtimeManifestEntryDigest(runtime: RideCodexRuntimeManifestEntry): string {
    const canonical = JSON.stringify({
        compressedBytes: runtime.compressedBytes,
        entrypoint: runtime.entrypoint,
        integrity: runtime.integrity,
        layoutVersion: runtime.layoutVersion,
        npmVersion: runtime.npmVersion,
        package: runtime.package,
        target: runtime.target,
        unpackedBytes: runtime.unpackedBytes,
        url: runtime.url,
        version: runtime.version
    });
    return `sha256-${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function requireDataRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('record');
    }
    const keys = Object.keys(value).sort();
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
        throw new Error('keys');
    }
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            throw new Error('property');
        }
        record[key] = descriptor.value;
    }
    return record;
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isValidSha512Integrity(value: unknown): value is string {
    if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        return false;
    }
    const encoded = value.slice('sha512-'.length);
    const digest = Buffer.from(encoded, 'base64');
    return digest.length === 64 && digest.toString('base64') === encoded;
}
