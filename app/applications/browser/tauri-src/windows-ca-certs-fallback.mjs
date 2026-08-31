import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const PACKAGE_NAME = '@vscode/windows-ca-certs';
const FALLBACK_NAMESPACE = 'ride-windows-ca-certs-fallback';
const FALLBACK_SOURCE = `
class Crypt32 {
    next() {
        return undefined;
    }

    done() {}
}

export { Crypt32 };
`;

export function resolveWindowsCaCertsNativePath(applicationRoot) {
    const localRequire = createRequire(path.join(path.resolve(applicationRoot), 'package.json'));
    try {
        const manifestPath = localRequire.resolve(`${PACKAGE_NAME}/package.json`);
        return path.join(path.dirname(manifestPath), 'build', 'Release', 'crypt32.node');
    } catch {
        return undefined;
    }
}

export function createWindowsCaCertsFallbackPlugin({
    applicationRoot,
    platform = process.platform,
    nativePath = resolveWindowsCaCertsNativePath(applicationRoot),
} = {}) {
    const shouldFallback = platform === 'win32'
        && (typeof nativePath !== 'string' || !fs.existsSync(nativePath));

    return {
        name: 'ride-windows-ca-certs-fallback',
        setup(build) {
            if (!shouldFallback) {
                return;
            }
            console.warn('Tauri backend build: @vscode/windows-ca-certs is not compiled; using the Node.js certificate store fallback.');
            build.onResolve({ filter: /^@vscode\/windows-ca-certs$/ }, () => ({
                path: FALLBACK_NAMESPACE,
                namespace: FALLBACK_NAMESPACE,
            }));
            build.onLoad({ filter: /^ride-windows-ca-certs-fallback$/ }, () => ({
                contents: FALLBACK_SOURCE,
                loader: 'js',
            }));
        },
    };
}
