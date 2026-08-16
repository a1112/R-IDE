import path from 'node:path';
import { createRequire } from 'node:module';

const THEIA_PACKAGE_PREFIX = '@theia/';

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
