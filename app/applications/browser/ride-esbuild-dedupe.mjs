import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const THEIA_PACKAGE_PREFIX = '@theia/';

function logicalResolvedPackagePath(applicationRoot, request, resolvedPath) {
    const segments = request.split('/');
    while (segments.at(-1) === '') {
        segments.pop();
    }
    if (segments.length < 2 || segments.some(segment => !segment || segment === '.' || segment === '..')) {
        return undefined;
    }
    let logicalPackage;
    let directory = path.resolve(applicationRoot);
    while (true) {
        const candidate = path.join(directory, 'node_modules', segments[0], segments[1]);
        if (fs.existsSync(candidate)) {
            logicalPackage = candidate;
            break;
        }
        const parent = path.dirname(directory);
        if (parent === directory) {
            return undefined;
        }
        directory = parent;
    }
    let physicalPackage;
    try {
        physicalPackage = fs.realpathSync(logicalPackage);
    } catch {
        return undefined;
    }
    const relative = path.relative(physicalPackage, resolvedPath);
    if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return undefined;
    }
    return path.join(logicalPackage, relative);
}

/**
 * Keep shared Theia service class identities stable.
 *
 * The browser workspace can contain second copies nested below another Theia
 * package when another workspace application hoists a different Theia release
 * to app/node_modules. Inversify treats classes from the two copies as
 * different service identifiers, so contributions cannot find bindings that
 * were registered by the corresponding backend module.
 */
export function createTheiaModuleDedupePlugin(applicationRoot) {
  const browserRequire = createRequire(path.join(applicationRoot, 'package.json'));

  return {
    name: 'ride-theia-module-dedupe',
    setup(build) {
      build.onResolve(
        { filter: /^@theia\/[^/]+(?:\/.*)?$/ },
        ({ path: request }) => {
          // A profile may link packages from an external store with a Windows
          // junction. Returning the logical path lets esbuild keep resolving
          // peers from the profile's node_modules directory; browserRequire
          // canonicalizes the junction and can select another workspace tree.
          try {
            const resolvedPath = browserRequire.resolve(request);
            const logicalPath = logicalResolvedPackagePath(applicationRoot, request, resolvedPath);
            return { path: logicalPath ?? resolvedPath };
          } catch (error) {
            if (request.split('/').length === 2) {
              const packageName = request.slice(THEIA_PACKAGE_PREFIX.length);
              return {
                path: path.join(applicationRoot, 'node_modules', '@theia', packageName),
              };
            }
            throw error;
          }
        },
      );
    },
  };
}
