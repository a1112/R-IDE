const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '..', 'build-tauri-backend.js');
const browserDirectory = path.resolve(__dirname, '..', '..', 'applications', 'browser');
const profileDirectory = path.join(browserDirectory, '.ride-tauri-profile');

test('defaults to an isolated tauri-critical build and publishes it atomically', () => {
  const { createBuildPlan } = require(helperPath);
  const plan = createBuildPlan('win32', undefined, {});

  assert.equal(plan.length, 4);
  assert.equal(plan[0].command, process.execPath);
  assert.deepEqual(plan[0].args.slice(-3), ['prepare', '--profile', 'tauri-critical']);
  assert.equal(plan[0].cwd, browserDirectory);
  assert.equal(plan[1].command, process.execPath);
  assert.match(plan[1].args[0], /@theia[\\/]cli[\\/]bin[\\/]theia\.js$/);
  assert.deepEqual(plan[1].args.slice(1), ['rebuild:browser', '--cacheRoot', path.resolve(browserDirectory, '..', '..')]);
  assert.equal(plan[1].cwd, profileDirectory);
  assert.equal(plan[2].command, process.execPath);
  assert.deepEqual(plan[2].args.slice(1), ['build', '--app-target=browser']);
  assert.equal(plan[2].cwd, profileDirectory);
  assert.equal(plan[3].command, process.execPath);
  assert.deepEqual(plan[3].args.slice(-3), ['publish', '--profile', 'tauri-critical']);
  assert.equal(plan[3].cwd, browserDirectory);
  for (const step of plan) {
    assert.equal(step.env.RIDE_TAURI_FRONTEND_PROFILE, 'tauri-critical');
    assert.equal(step.env.RIDE_TAURI_LEAN, undefined);
    assert.equal(step.env.RIDE_TAURI_ENABLE_PLUGINS, undefined);
    assert.equal(step.shell, false);
  }
});

test('uses the explicit full profile and every browser root', () => {
  const { createBuildPlan } = require(helperPath);
  const plan = createBuildPlan('linux', undefined, { RIDE_TAURI_FRONTEND_PROFILE: 'full' });

  assert.equal(plan[1].command, process.execPath);
  assert.equal(plan[2].command, process.execPath);
  assert.deepEqual(plan[0].args.slice(-3), ['prepare', '--profile', 'full']);
  assert.deepEqual(plan[3].args.slice(-3), ['publish', '--profile', 'full']);
  assert.equal(plan[2].env.RIDE_TAURI_FRONTEND_PROFILE, 'full');

  const config = JSON.parse(fs.readFileSync(path.join(browserDirectory, 'tauri-profile.json'), 'utf8'));
  assert.equal(config.profiles.full.includeAllBrowserRoots, true);
});

test('rejects unknown profiles before spawning any build process', () => {
  const { createBuildPlan } = require(helperPath);
  assert.throws(() => createBuildPlan('linux', 'lean'), /Unknown Tauri frontend profile "lean"/);
  assert.throws(
    () => createBuildPlan('linux', undefined, { RIDE_TAURI_FRONTEND_PROFILE: 'mystery' }),
    /Unknown Tauri frontend profile "mystery"/,
  );
});

test('invokes the workspace Theia CLI through Node without shell-specific wrappers', () => {
  const { runBuild } = require(helperPath);
  const calls = [];
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  };

  assert.equal(runBuild('win32', fakeSpawn, 'tauri-critical', {}), 0);

  assert.equal(calls.length, 4);
  assert.equal(calls[0].command, process.execPath);
  assert.equal(calls[1].command, process.execPath);
  assert.deepEqual(calls[1].args.slice(1), ['rebuild:browser', '--cacheRoot', path.resolve(browserDirectory, '..', '..')]);
  assert.equal(calls[2].command, process.execPath);
  assert.deepEqual(calls[2].args.slice(1), ['build', '--app-target=browser']);
  assert.equal(calls[3].command, process.execPath);
  assert.equal(calls[2].options.shell, false);
  assert.equal(calls[2].options.env.RIDE_TAURI_FRONTEND_PROFILE, 'tauri-critical');
});

test('declares only exact existing browser roots and named deferred groups', () => {
  const browserManifest = JSON.parse(fs.readFileSync(path.join(browserDirectory, 'package.json'), 'utf8'));
  const profile = JSON.parse(fs.readFileSync(path.join(browserDirectory, 'tauri-profile.json'), 'utf8'));
  const browserRoots = new Set(Object.keys(browserManifest.dependencies));

  assert.equal(profile.schema, 'ride.tauri-frontend-profile@1');
  for (const root of profile.profiles['tauri-critical'].roots) {
    assert.ok(browserRoots.has(root), `critical root must exist exactly: ${root}`);
  }
  assert.deepEqual(Object.keys(profile.deferredGroups).sort(), [
    'ai',
    'auxiliary',
    'collaboration',
    'notebook',
    'preview-getting-started',
  ]);
  for (const group of Object.values(profile.deferredGroups)) {
    for (const root of group.roots) {
      assert.ok(browserRoots.has(root), `deferred root must exist exactly: ${root}`);
    }
    for (const root of group.retainedRoots ?? []) {
      assert.ok(browserRoots.has(root), `retained root must exist exactly: ${root}`);
    }
  }
  assert.deepEqual([...profile.buildDevDependencies].sort(), ['@theia/bundle-plugin', '@theia/cli']);
});

test('removes string and prefix lean filtering while retaining build safety fixes', () => {
  const buildSource = fs.readFileSync(helperPath, 'utf8');
  const esbuildSource = fs.readFileSync(path.join(browserDirectory, 'esbuild.mjs'), 'utf8');
  const combined = `${buildSource}\n${esbuildSource}`;

  assert.doesNotMatch(combined, /RIDE_TAURI_LEAN|RIDE_TAURI_ENABLE_PLUGINS/);
  assert.doesNotMatch(esbuildSource, /leanTauri|startsWith\(prefix\)|split\(['"]\\n['"]\)\.filter/);
  assert.doesNotMatch(esbuildSource, /src-gen.*writeFileSync|patchGeneratedFilesForLeanTauri/s);
  assert.match(esbuildSource, /createTheiaModuleDedupePlugin/);
  assert.match(esbuildSource, /patchBuiltParcelWatcherLoad/);
  assert.match(esbuildSource, /native\/watcher\.node/);
});

test('ignores generated profile targets and atomic staging directories', () => {
  const ignore = fs.readFileSync(path.resolve(browserDirectory, '..', '..', '.gitignore'), 'utf8');
  assert.match(ignore, /\*\*\/\.ride-tauri-profile\//);
  assert.match(ignore, /\*\*\/\.ride-tauri-profile\.tmp-\*/);
  assert.match(ignore, /\*\*\/\.ride-tauri-lib\.tmp-\*/);
});
