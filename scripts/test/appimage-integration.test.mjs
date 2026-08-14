import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tauriDirectory = path.join(repositoryRoot, 'app', 'applications', 'tauri', 'src-tauri');
const tauriConfigPath = path.join(tauriDirectory, 'tauri.conf.json');
const linuxConfigPath = path.join(tauriDirectory, 'tauri.linux.conf.json');
const integrationScriptPath = path.join(tauriDirectory, 'linux', 'appimage-integration.sh');
const mimeSourcePath = path.join(tauriDirectory, 'linux', 'r-ide-mime.xml');
const isWindows = process.platform === 'win32';
const expectedMimeList = `${JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8')).bundle.fileAssociations
  .map(({ mimeType }) => mimeType)
  .join(';')};`;

function requiredFile(filePath, description) {
  assert.ok(fs.existsSync(filePath), `expected ${description} at ${filePath}`);
  return fs.readFileSync(filePath, 'utf8');
}

function toPosixPath(filePath) {
  if (!isWindows) {
    return filePath;
  }
  const result = spawnSync('wsl.exe', ['-e', 'wslpath', '-a', filePath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.replaceAll('\0', '').trim();
}

function posixEnvironment(paths) {
  return {
    HOME: toPosixPath(paths.home),
    XDG_CONFIG_HOME: toPosixPath(paths.configHome),
    XDG_DATA_HOME: toPosixPath(paths.dataHome),
    LC_ALL: 'C',
  };
}

function runPosixScript(scriptPath, args, environment) {
  const posixScriptPath = toPosixPath(scriptPath);
  const posixArgs = args.map((argument) => (
    path.isAbsolute(argument) ? toPosixPath(argument) : argument
  ));
  if (isWindows) {
    return spawnSync(
      'wsl.exe',
      ['-e', 'env', ...Object.entries(environment).map(([key, value]) => `${key}=${value}`), 'sh', posixScriptPath, ...posixArgs],
      { encoding: 'utf8' },
    );
  }
  return spawnSync('sh', [posixScriptPath, ...posixArgs], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

function runPosixCommand(command, args, environment) {
  if (isWindows) {
    return spawnSync(
      'wsl.exe',
      [
        '-e',
        'env',
        ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
        command,
        ...args.map((argument) => (path.isAbsolute(argument) ? toPosixPath(argument) : argument)),
      ],
      { encoding: 'utf8' },
    );
  }
  return spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

function commandAvailable(command) {
  const result = isWindows
    ? spawnSync('wsl.exe', ['-e', 'sh', '-c', `command -v ${command}`], { encoding: 'utf8' })
    : spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' });
  return result.status === 0;
}

function queryDefaultHandler(environment) {
  const command = 'command -v xdg-mime >/dev/null 2>&1 && xdg-mime query default text/plain || true';
  if (isWindows) {
    return spawnSync(
      'wsl.exe',
      ['-e', 'env', ...Object.entries(environment).map(([key, value]) => `${key}=${value}`), 'sh', '-c', command],
      { encoding: 'utf8' },
    ).stdout.replaceAll('\0', '').trim();
  }
  return spawnSync('sh', ['-c', command], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  }).stdout.trim();
}

function assertSucceeded(result) {
  assert.equal(
    result.status,
    0,
    `command failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
}

function escapeDesktopExecArgument(argument) {
  return argument
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('`', '\\`')
    .replaceAll('$', '\\$')
    .replaceAll('%', '%%');
}

test('AppImage packaging carries an explicit host integration helper and its MIME source', () => {
  const linuxConfig = JSON.parse(requiredFile(linuxConfigPath, 'Linux Tauri config'));
  const appImageFiles = linuxConfig.bundle.linux.appimage.files;

  assert.equal(
    appImageFiles['/usr/lib/R-IDE/appimage-integration.sh'],
    'linux/appimage-integration.sh',
  );
  assert.equal(
    appImageFiles['/usr/lib/R-IDE/r-ide-mime.xml'],
    'linux/r-ide-mime.xml',
  );
});

test('AppImage integration is explicit, reversible, idempotent, and preserves defaults', (context) => {
  requiredFile(integrationScriptPath, 'AppImage integration script');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'r-ide appimage integration '));
  context.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const paths = {
    home: path.join(sandbox, 'home'),
    configHome: path.join(sandbox, 'config'),
    dataHome: path.join(sandbox, 'data'),
  };
  const appImagePath = path.join(sandbox, 'R IDE.AppImage');
  const mimeAppsPath = path.join(paths.configHome, 'mimeapps.list');
  const installedMimePath = path.join(paths.dataHome, 'mime', 'packages', 'r-ide.xml');
  const installedDesktopPath = path.join(paths.dataHome, 'applications', 'r-ide-appimage.desktop');
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.configHome, { recursive: true });
  fs.writeFileSync(appImagePath, 'appimage placeholder');
  fs.writeFileSync(
    mimeAppsPath,
    '[Default Applications]\ntext/plain=existing-editor.desktop;\n',
  );
  const environment = posixEnvironment(paths);
  const defaultFileBefore = fs.readFileSync(mimeAppsPath, 'utf8');
  const queriedDefaultBefore = queryDefaultHandler(environment);

  const firstIntegration = runPosixScript(
    integrationScriptPath,
    ['--integrate', appImagePath],
    environment,
  );
  assertSucceeded(firstIntegration);
  assert.equal(fs.readFileSync(installedMimePath, 'utf8'), fs.readFileSync(mimeSourcePath, 'utf8'));
  const desktopEntry = fs.readFileSync(installedDesktopPath, 'utf8');
  assert.match(desktopEntry, /^Type=Application$/m);
  assert.ok(desktopEntry.split(/\r?\n/).includes(`Exec="${toPosixPath(appImagePath)}" %F`));
  assert.match(desktopEntry, new RegExp(`^MimeType=${expectedMimeList.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.doesNotMatch(desktopEntry, /xdg-mime\s+default|mimeapps\.list/i);
  assert.ok(!fs.lstatSync(installedMimePath).isSymbolicLink());
  assert.ok(!fs.lstatSync(installedDesktopPath).isSymbolicLink());
  if (!isWindows) {
    assert.equal(fs.statSync(installedMimePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(installedDesktopPath).mode & 0o777, 0o600);
    for (const directory of [
      paths.dataHome,
      path.dirname(path.dirname(installedMimePath)),
      path.dirname(installedMimePath),
      path.dirname(installedDesktopPath),
    ]) {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    }
  }
  assert.deepEqual(
    fs.readdirSync(path.dirname(installedMimePath)).filter((entry) => entry.startsWith('.r-ide')),
    [],
  );
  assert.deepEqual(
    fs.readdirSync(path.dirname(installedDesktopPath)).filter((entry) => entry.startsWith('.r-ide')),
    [],
  );
  if (commandAvailable('desktop-file-validate')) {
    assertSucceeded(runPosixCommand(
      'desktop-file-validate',
      [installedDesktopPath],
      environment,
    ));
  }
  if (commandAvailable('gio') && commandAvailable('update-desktop-database')) {
    const discovery = runPosixCommand('gio', ['mime', 'application/x-shellscript'], environment);
    assertSucceeded(discovery);
    assert.match(discovery.stdout, /r-ide-appimage\.desktop/);
  }
  if (commandAvailable('gio') && commandAvailable('update-mime-database')) {
    const mimeProbes = new Map([
      ['fish', 'application/x-fishscript'],
      ['js', 'text/javascript'],
      ['ts', 'application/typescript'],
      ['yaml', 'application/yaml'],
    ]);
    for (const [extension, mimeType] of mimeProbes) {
      const probePath = path.join(sandbox, `probe.${extension}`);
      fs.writeFileSync(probePath, 'R-IDE MIME probe\n');
      const probe = runPosixCommand(
        'gio',
        ['info', '--attributes=standard::content-type', probePath],
        environment,
      );
      assertSucceeded(probe);
      assert.match(probe.stdout, new RegExp(`standard::content-type: ${mimeType}`));
    }
  }

  const installedMimeBeforeRepeat = fs.readFileSync(installedMimePath, 'utf8');
  const installedDesktopBeforeRepeat = fs.readFileSync(installedDesktopPath, 'utf8');
  assertSucceeded(runPosixScript(integrationScriptPath, ['--integrate', appImagePath], environment));
  assert.equal(fs.readFileSync(installedMimePath, 'utf8'), installedMimeBeforeRepeat);
  assert.equal(fs.readFileSync(installedDesktopPath, 'utf8'), installedDesktopBeforeRepeat);
  assert.equal(fs.readFileSync(mimeAppsPath, 'utf8'), defaultFileBefore);
  assert.equal(queryDefaultHandler(environment), queriedDefaultBefore);

  assertSucceeded(runPosixScript(integrationScriptPath, ['--unintegrate', appImagePath], environment));
  assert.ok(!fs.existsSync(installedMimePath));
  assert.ok(!fs.existsSync(installedDesktopPath));
  assertSucceeded(runPosixScript(integrationScriptPath, ['--unintegrate', appImagePath], environment));
  assert.equal(fs.readFileSync(mimeAppsPath, 'utf8'), defaultFileBefore);
  assert.equal(queryDefaultHandler(environment), queriedDefaultBefore);
});

test('AppImage integration rejects a symlink launcher path', (context) => {
  requiredFile(integrationScriptPath, 'AppImage integration script');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'r-ide appimage symlink '));
  context.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const paths = {
    home: path.join(sandbox, 'home'),
    configHome: path.join(sandbox, 'config'),
    dataHome: path.join(sandbox, 'data'),
  };
  const appImagePath = path.join(sandbox, 'R IDE.AppImage');
  const symlinkPath = path.join(sandbox, 'R IDE link.AppImage');
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.configHome, { recursive: true });
  fs.writeFileSync(appImagePath, 'appimage placeholder');
  try {
    fs.symlinkSync(appImagePath, symlinkPath, 'file');
  } catch (error) {
    if (isWindows && error.code === 'EPERM') {
      context.skip('Windows symlink creation is not permitted');
      return;
    }
    throw error;
  }

  const result = runPosixScript(integrationScriptPath, ['--integrate', symlinkPath], posixEnvironment(paths));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic link|canonical/i);
  assert.ok(!fs.existsSync(path.join(paths.dataHome, 'mime', 'packages', 'r-ide.xml')));
});

test('AppImage integration safely escapes reserved desktop Exec characters', (context) => {
  if (isWindows) {
    context.skip('Windows filenames cannot exercise the complete desktop Exec character set');
    return;
  }
  requiredFile(integrationScriptPath, 'AppImage integration script');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'r-ide appimage escaping '));
  context.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const paths = {
    home: path.join(sandbox, 'home'),
    configHome: path.join(sandbox, 'config'),
    dataHome: path.join(sandbox, 'data'),
  };
  const appImagePath = path.join(sandbox, 'R "$IDE%` AppImage');
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.configHome, { recursive: true });
  fs.writeFileSync(appImagePath, 'appimage placeholder');

  assertSucceeded(runPosixScript(
    integrationScriptPath,
    ['--integrate', appImagePath],
    posixEnvironment(paths),
  ));
  const installedDesktopPath = path.join(
    paths.dataHome,
    'applications',
    'r-ide-appimage.desktop',
  );
  const desktopEntry = fs.readFileSync(installedDesktopPath, 'utf8');
  assert.ok(desktopEntry.split(/\r?\n/).includes(
    `Exec="${escapeDesktopExecArgument(appImagePath)}" %F`,
  ));
  if (commandAvailable('desktop-file-validate')) {
    assertSucceeded(runPosixCommand(
      'desktop-file-validate',
      [installedDesktopPath],
      posixEnvironment(paths),
    ));
  }
});

test('AppImage integration refuses to replace an existing symlink target', (context) => {
  requiredFile(integrationScriptPath, 'AppImage integration script');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'r-ide appimage target symlink '));
  context.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const paths = {
    home: path.join(sandbox, 'home'),
    configHome: path.join(sandbox, 'config'),
    dataHome: path.join(sandbox, 'data'),
  };
  const appImagePath = path.join(sandbox, 'R IDE.AppImage');
  const packagesDirectory = path.join(paths.dataHome, 'mime', 'packages');
  const installedMimePath = path.join(packagesDirectory, 'r-ide.xml');
  const victimPath = path.join(sandbox, 'must-not-change.txt');
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.configHome, { recursive: true });
  fs.mkdirSync(packagesDirectory, { recursive: true });
  fs.writeFileSync(appImagePath, 'appimage placeholder');
  fs.writeFileSync(victimPath, 'sentinel');
  try {
    fs.symlinkSync(victimPath, installedMimePath, 'file');
  } catch (error) {
    if (isWindows && error.code === 'EPERM') {
      context.skip('Windows symlink creation is not permitted');
      return;
    }
    throw error;
  }

  const result = runPosixScript(
    integrationScriptPath,
    ['--integrate', appImagePath],
    posixEnvironment(paths),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic link/i);
  assert.equal(fs.readFileSync(victimPath, 'utf8'), 'sentinel');
  assert.ok(fs.lstatSync(installedMimePath).isSymbolicLink());
});

test('AppImage helper uses fixed owned paths, atomic replacement, and no default-handler writes', () => {
  const source = requiredFile(integrationScriptPath, 'AppImage integration script');

  assert.match(source, /r-ide\.xml/);
  assert.match(source, /r-ide-appimage\.desktop/);
  assert.match(source, /mktemp/);
  assert.match(source, /mv\s+(?:-[^\s]+\s+)*--?/);
  assert.match(source, /umask\s+077/);
  assert.doesNotMatch(source, /xdg-mime\s+default|mimeapps\.list/i);
});
