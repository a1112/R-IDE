const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.resolve(__dirname, '..', 'build-tauri-backend.js');

test('uses native Windows executables and an explicit environment', () => {
  const { createBuildPlan } = require(helperPath);
  const plan = createBuildPlan('win32');

  assert.equal(plan[0].command, 'yarn.cmd');
  assert.equal(plan[1].command, 'yarn.cmd');
  assert.equal(plan[1].env.RIDE_TAURI_LEAN, '1');
  assert.deepEqual(plan[1].args, ['theia', 'build', '--app-target=browser']);
  assert.equal(plan[1].shell, false);
});

test('uses the POSIX yarn executable on Unix-like platforms', () => {
  const { createBuildPlan } = require(helperPath);
  const plan = createBuildPlan('linux');

  assert.equal(plan[0].command, 'yarn');
  assert.equal(plan[1].command, 'yarn');
});

test('invokes Windows yarn.cmd through ComSpec without shell prefixes', () => {
  const { runBuild } = require(helperPath);
  const calls = [];
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  };

  assert.equal(runBuild('win32', fakeSpawn), 0);

  const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, comspec);
  assert.deepEqual(calls[0].args, ['/d', '/s', '/c', 'yarn.cmd run rebuild']);
  assert.equal(calls[1].command, comspec);
  assert.deepEqual(calls[1].args, ['/d', '/s', '/c', 'yarn.cmd theia build --app-target=browser']);
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[1].options.env.RIDE_TAURI_LEAN, '1');
  assert.doesNotMatch(calls[1].args[3], /RIDE_TAURI_LEAN=1/);
});

test('bundle plugin script enables copy mode through an argument', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'applications', 'tauri', 'copy-plugins.js'), 'utf8');
  assert.match(source, /process\.argv\.includes\(['"]--bundle['"]\)/);
  assert.match(source, /shouldCopyPlugins\s*=\s*.*--bundle/);
});
