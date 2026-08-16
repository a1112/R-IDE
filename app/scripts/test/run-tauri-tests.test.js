const assert = require('node:assert/strict');
const test = require('node:test');

const {
  commonControlsManifest,
  parseTestExecutables,
  windowsSdkArchitecture,
} = require('../run-tauri-tests');

test('parseTestExecutables returns unique Rust test harnesses', () => {
  const output = [
    JSON.stringify({
      reason: 'compiler-artifact',
      profile: { test: true },
      target: { kind: ['lib'] },
      executable: 'C:\\target\\debug\\deps\\ride_tauri.exe',
    }),
    JSON.stringify({
      reason: 'compiler-artifact',
      profile: { test: true },
      target: { kind: ['lib'] },
      executable: 'C:\\target\\debug\\deps\\ride_tauri.exe',
    }),
    JSON.stringify({ reason: 'build-script-executed' }),
    'not json',
  ].join('\n');

  assert.deepEqual(parseTestExecutables(output), [
    'C:\\target\\debug\\deps\\ride_tauri.exe',
  ]);
});

test('parseTestExecutables ignores non-test compiler artifacts', () => {
  const output = JSON.stringify({
    reason: 'compiler-artifact',
    profile: { test: false },
    target: { kind: ['bin'] },
    executable: 'C:\\target\\debug\\ride-tauri.exe',
  });

  assert.deepEqual(parseTestExecutables(output), []);
});

test('windowsSdkArchitecture maps Node architectures to SDK directories', () => {
  assert.equal(windowsSdkArchitecture('x64'), 'x64');
  assert.equal(windowsSdkArchitecture('ia32'), 'x86');
  assert.equal(windowsSdkArchitecture('arm64'), 'arm64');
  assert.throws(() => windowsSdkArchitecture('mips'), /Unsupported Windows architecture/);
});

test('manifest requests Common Controls version 6', () => {
  assert.match(commonControlsManifest, /Microsoft\.Windows\.Common-Controls/);
  assert.match(commonControlsManifest, /version="6\.0\.0\.0"/);
});
