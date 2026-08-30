import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tauriDirectory = path.join(appDirectory, 'applications', 'tauri', 'src-tauri');
const readTauriFile = (...segments) => fs.readFileSync(path.join(tauriDirectory, ...segments), 'utf8');

test('global Tauri configuration keeps borderless transparent composition for non-Windows platforms', () => {
  const config = JSON.parse(readTauriFile('tauri.conf.json'));
  const mainWindow = config.app.windows.find(window => window.label === 'main');

  assert.ok(mainWindow, 'expected main Tauri window configuration');
  assert.equal(mainWindow.decorations, false);
  assert.equal(mainWindow.transparent, true);
  assert.equal(mainWindow.backgroundColor, '#00000000');
});

test('Windows composition is applied to the cloned main-window config before it is built', () => {
  const source = readTauriFile('src', 'lib.rs');
  const clone = source.indexOf('.find(|config| config.label == "main")');
  const applyPolicy = source.indexOf('apply_windows_main_window_composition(&mut main_window_config)');
  const build = source.indexOf('WebviewWindowBuilder::from_config(app.handle(), &main_window_config)');

  assert.ok(clone >= 0, 'expected the main window configuration to be cloned');
  assert.ok(applyPolicy > clone, 'Windows composition must mutate only the cloned configuration');
  assert.ok(build > applyPolicy, 'Windows composition must be applied before window construction');
  assert.match(source, /#\[cfg\(windows\)\]\s*fn apply_windows_main_window_composition/);
  assert.match(source, /config\.transparent\s*=\s*composition\.transparent/);
  assert.match(source, /config\.background_color\s*=\s*Some\(tauri::utils::config::Color\(/);
});

test('native chrome is configured before the main window is shown', () => {
  const source = readTauriFile('src', 'lib.rs');
  const configure = source.indexOf('native_chrome::configure_native_window(window)');
  const show = source.indexOf('window.show()?');

  assert.ok(configure >= 0, 'expected native chrome configuration');
  assert.ok(show > configure, 'native chrome must be configured before window.show');
});

test('Windows native chrome requests DWM rounded corners with one bounded warning path', () => {
  const source = readTauriFile('src', 'native_chrome.rs');
  const configure = source.match(/pub fn configure_native_window[\s\S]*?\n}/)?.[0];

  assert.ok(configure, 'expected configure_native_window');
  assert.match(configure, /#\[cfg\(windows\)\]\s*configure_windows_window\(window\)/);
  assert.match(source, /#\[cfg\(windows\)\]\s*fn configure_windows_window/);
  assert.match(source, /DwmSetWindowAttribute/);
  assert.match(source, /DWMWA_WINDOW_CORNER_PREFERENCE/);
  assert.match(source, /DWMWCP_ROUND/);
  assert.match(source, /if\s+result\s*<\s*0/);
  assert.equal(
    (source.match(/Failed to apply Windows DWM corner preference/g) ?? []).length,
    1,
    'DWM setup must emit at most one bounded warning from one call path',
  );
  const windowsHelper = source.match(/#\[cfg\(windows\)\]\s*fn configure_windows_window[\s\S]*?\n}/)?.[0];
  assert.ok(windowsHelper, 'expected Windows helper');
  assert.doesNotMatch(windowsHelper, /\b(?:loop|while|for)\b/);
});

test('Windows dependency enables only the required DWM and HWND API families', () => {
  const manifest = readTauriFile('Cargo.toml');

  assert.match(manifest, /"Win32_Graphics_Dwm"/);
  assert.match(manifest, /"Win32_UI_WindowsAndMessaging"/);
});
