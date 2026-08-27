import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const THEIA_PACKAGE_PREFIX = '@theia/';

function logicalPackagePath(applicationRoot, request) {
  const segments = request.split('/');
  if (segments.length < 2 || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    return undefined;
  }
  const candidate = path.join(applicationRoot, 'node_modules', ...segments);
  return fs.existsSync(candidate) ? candidate : undefined;
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
          const logicalPath = logicalPackagePath(applicationRoot, request);
          if (logicalPath) {
            return { path: logicalPath };
          }
          try {
            return { path: browserRequire.resolve(request) };
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
