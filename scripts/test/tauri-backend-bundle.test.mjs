import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTheiaModuleDedupePlugin } from '../../app/applications/browser/ride-esbuild-dedupe.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const browserRoot = path.join(repositoryRoot, 'app', 'applications', 'browser');

test('the backend bundle dedupe resolver maps shared Theia modules to browser dependencies', () => {
  let resolver;
  createTheiaModuleDedupePlugin(browserRoot).setup({
    onResolve(_options, callback) {
      resolver = callback;
    },
  });
  assert.equal(typeof resolver, 'function');

  for (const request of [
    '@theia/plugin-ext-vscode/lib/common/plugin-vscode-environment',
    '@theia/process/lib/node/process-manager',
  ]) {
    const result = resolver({ path: request });
    assert.ok(result?.path, `expected a resolved path for ${request}`);
    assert.ok(
      path.normalize(result.path).startsWith(path.join(browserRoot, 'node_modules')),
      `${request} must resolve from the browser workspace dependencies`,
    );
  }
});

const frontendSourceMapPath = path.join(browserRoot, 'lib', 'frontend', 'bundle.js.map');

test('the frontend bundle contains one shared Theia task protocol module', {
  skip: !fs.existsSync(frontendSourceMapPath) && 'source-map inventory is opt-in',
}, () => {
  const sourceMapPath = frontendSourceMapPath;
  const sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, 'utf8'));
  const taskProtocolSources = sourceMap.sources.filter(source =>
    source.endsWith('/@theia/task/src/common/process/task-protocol.ts'),
  );

  assert.equal(
    taskProtocolSources.length,
    1,
    `expected one task protocol module, found:\n${taskProtocolSources.join('\n')}`,
  );
});

test('the backend bundle loads the Parcel watcher native module', () => {
  const backendBundlePath = path.join(browserRoot, 'lib', 'backend', 'main.js');
  const backendBundle = fs.readFileSync(backendBundlePath, 'utf8');

  assert.doesNotMatch(
    backendBundle,
    /\.exports\s*=\s*["']\.\/native\/watcher\.node["']/,
    'the native watcher path must not be exported as a plain string',
  );
  assert.match(
    backendBundle,
    /require\(["']\.\/native\/watcher\.node["']\)/,
    'the native watcher must be loaded with require()',
  );
});

test('Tauri copies complete frontend and backend trees through bounded atomic publishers', () => {
  const tauriRoot = path.join(repositoryRoot, 'app', 'applications', 'tauri');
  const helper = fs.readFileSync(path.join(tauriRoot, 'copy-build-tree.js'), 'utf8');
  const frontendCopy = fs.readFileSync(path.join(tauriRoot, 'copy-frontend.js'), 'utf8');
  const backendCopy = fs.readFileSync(path.join(tauriRoot, 'copy-backend.js'), 'utf8');

  assert.match(helper, /function copyRegularTree/);
  assert.match(helper, /lstatSync/);
  assert.match(helper, /isSymbolicLink\(\)/);
  assert.match(helper, /function publishDirectoryAtomic/);
  assert.match(frontendCopy, /copyRegularTree\(sourceDir, stagingDirectory/);
  assert.match(backendCopy, /copyRegularTree\(sourceDir, stagingDirectory/);
  assert.match(frontendCopy, /includeSourceMaps:\s*process\.env\.RIDE_COPY_SOURCEMAPS === '1'/);
  assert.match(backendCopy, /includeSourceMaps:\s*process\.env\.RIDE_COPY_SOURCEMAPS === '1'/);
  assert.doesNotMatch(frontendCopy, /const filesToCopy/);
});

test('Tauri packaged build verification requires matching profile identities and deferred chunks', () => {
  const verification = fs.readFileSync(
    path.join(repositoryRoot, 'app', 'applications', 'tauri', 'verify-build.js'),
    'utf8',
  );
  const helper = fs.readFileSync(
    path.join(repositoryRoot, 'app', 'applications', 'tauri', 'copy-build-tree.js'),
    'utf8',
  );
  assert.match(`${verification}\n${helper}`, /browser-frontend[\s\S]*ride-tauri-profile\.json/);
  assert.match(verification, /resources\/backend|resources', 'backend/);
  assert.match(verification, /Frontend\/backend profile identity matches/);
  assert.match(verification, /validatePackagedProfileAssets/);
  assert.match(helper, /deferredFrontendModules/);
  assert.match(helper, /Missing packaged deferred feature chunk/);
});
