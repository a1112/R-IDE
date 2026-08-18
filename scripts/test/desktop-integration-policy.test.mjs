import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = path.join(
  repositoryRoot,
  'app',
  'applications',
  'tauri',
  'src-tauri',
  'tauri.conf.json',
);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const tauriDirectory = path.dirname(configPath);
const windowsConfigPath = path.join(tauriDirectory, 'tauri.windows.conf.json');
const nsisHooksPath = path.join(tauriDirectory, 'windows', 'file-associations.nsh');
const wixFragmentPath = path.join(tauriDirectory, 'windows', 'file-associations.wxs');
const linuxConfigPath = path.join(tauriDirectory, 'tauri.linux.conf.json');
const linuxDesktopTemplatePath = path.join(tauriDirectory, 'linux', 'r-ide.desktop');
const appImageDesktopPath = path.join(tauriDirectory, 'linux', 'r-ide-appimage.desktop');
const linuxMimePackagePath = path.join(tauriDirectory, 'linux', 'r-ide-mime.xml');
const linuxMimeUpdateScriptPath = path.join(tauriDirectory, 'linux', 'update-mime-database.sh');
const appImageIntegrationScriptPath = path.join(
  tauriDirectory,
  'linux',
  'appimage-integration.sh',
);
const cargoManifestPath = path.join(tauriDirectory, 'Cargo.toml');
const isWindows = process.platform === 'win32';

const editorAssociation = { role: 'Editor', rank: 'Alternate' };
const approvedAssociations = [
  { ext: ['bash', 'sh', 'zsh'], mimeType: 'application/x-shellscript', name: 'Shell Script', description: 'Shell script source file', ...editorAssociation },
  { ext: ['fish'], mimeType: 'application/x-fishscript', name: 'Fish Shell Script', description: 'Fish shell script source file', ...editorAssociation },
  { ext: ['bat', 'cmd'], mimeType: 'application/x-bat', name: 'Windows Command Script', description: 'Windows command script source file', ...editorAssociation },
  { ext: ['ps1', 'psm1'], mimeType: 'application/x-powershell', name: 'PowerShell Script', description: 'PowerShell script source file', ...editorAssociation },
  { ext: ['c'], mimeType: 'text/x-csrc', name: 'C Source', description: 'C source file', ...editorAssociation },
  { ext: ['h'], mimeType: 'text/x-chdr', name: 'C Header', description: 'C header file', ...editorAssociation },
  { ext: ['cc', 'cpp', 'cxx'], mimeType: 'text/x-c++src', name: 'C++ Source', description: 'C++ source file', ...editorAssociation },
  { ext: ['hpp'], mimeType: 'text/x-c++hdr', name: 'C++ Header', description: 'C++ header file', ...editorAssociation },
  { ext: ['cs'], mimeType: 'text/x-csharp', name: 'C# Source', description: 'C# source file', ...editorAssociation },
  { ext: ['go'], mimeType: 'text/x-go', name: 'Go Source', description: 'Go source file', ...editorAssociation },
  { ext: ['java'], mimeType: 'text/x-java', name: 'Java Source', description: 'Java source file', ...editorAssociation },
  { ext: ['kt', 'kts'], mimeType: 'text/x-kotlin', name: 'Kotlin Source', description: 'Kotlin source file', ...editorAssociation },
  { ext: ['rs'], mimeType: 'text/rust', name: 'Rust Source', description: 'Rust source file', ...editorAssociation },
  { ext: ['py', 'pyw'], mimeType: 'text/x-python', name: 'Python Source', description: 'Python source file', ...editorAssociation },
  { ext: ['r'], mimeType: 'text/x-r-source', name: 'R Source', description: 'R source file', ...editorAssociation },
  { ext: ['rmd'], mimeType: 'text/x-r-ide-r-markdown', name: 'R Markdown', description: 'R Markdown document', ...editorAssociation },
  { ext: ['qmd'], mimeType: 'text/x-r-ide-quarto', name: 'Quarto Markdown', description: 'Quarto Markdown document', ...editorAssociation },
  { ext: ['sql'], mimeType: 'application/sql', name: 'SQL Source', description: 'SQL source file', ...editorAssociation },
  { ext: ['htm', 'html'], mimeType: 'text/html', name: 'HTML Document', description: 'HTML source file', ...editorAssociation },
  { ext: ['css'], mimeType: 'text/css', name: 'CSS Stylesheet', description: 'CSS stylesheet source file', ...editorAssociation },
  { ext: ['scss'], mimeType: 'text/x-scss', name: 'SCSS Stylesheet', description: 'SCSS stylesheet source file', ...editorAssociation },
  { ext: ['less'], mimeType: 'text/x-r-ide-less', name: 'Less Stylesheet', description: 'Less stylesheet source file', ...editorAssociation },
  { ext: ['cjs', 'js', 'mjs'], mimeType: 'text/javascript', name: 'JavaScript Source', description: 'JavaScript source file', ...editorAssociation },
  { ext: ['jsx'], mimeType: 'text/x-r-ide-jsx', name: 'JavaScript JSX Source', description: 'JavaScript JSX source file', ...editorAssociation },
  { ext: ['cts', 'mts', 'ts'], mimeType: 'application/typescript', name: 'TypeScript Source', description: 'TypeScript source file', ...editorAssociation },
  { ext: ['tsx'], mimeType: 'text/x-r-ide-typescript-jsx', name: 'TypeScript TSX Source', description: 'TypeScript TSX source file', ...editorAssociation },
  { ext: ['svelte'], mimeType: 'text/x-r-ide-svelte', name: 'Svelte Component', description: 'Svelte component source file', ...editorAssociation },
  { ext: ['vue'], mimeType: 'text/x-r-ide-vue', name: 'Vue Component', description: 'Vue component source file', ...editorAssociation },
  { ext: ['json'], mimeType: 'application/json', name: 'JSON Document', description: 'JSON configuration file', ...editorAssociation },
  { ext: ['jsonc'], mimeType: 'application/x-r-ide-jsonc', name: 'JSON with Comments', description: 'JSON with comments configuration file', ...editorAssociation },
  { ext: ['code-workspace', 'theia-workspace'], mimeType: 'application/x-r-ide-workspace', name: 'IDE Workspace', description: 'IDE workspace configuration file', ...editorAssociation },
  { ext: ['xml'], mimeType: 'application/xml', name: 'XML Document', description: 'XML document', ...editorAssociation },
  { ext: ['yaml', 'yml'], mimeType: 'application/yaml', name: 'YAML Document', description: 'YAML configuration file', ...editorAssociation },
  { ext: ['toml'], mimeType: 'application/toml', name: 'TOML Document', description: 'TOML configuration file', ...editorAssociation },
  { ext: ['ini'], mimeType: 'text/x-r-ide-ini', name: 'INI Document', description: 'INI configuration file', ...editorAssociation },
  { ext: ['properties'], mimeType: 'text/x-r-ide-properties', name: 'Properties Document', description: 'Properties configuration file', ...editorAssociation },
  { ext: ['markdown', 'md'], mimeType: 'text/markdown', name: 'Markdown Document', description: 'Markdown document', ...editorAssociation },
];
const approvedExtensions = approvedAssociations.flatMap(({ ext }) => ext).sort();
const ubuntuSharedMimeInfo21Globs = new Map([
  ['c', 'text/x-csrc'],
  ['cc', 'text/x-c++src'],
  ['cpp', 'text/x-c++src'],
  ['cs', 'text/x-csharp'],
  ['css', 'text/css'],
  ['cxx', 'text/x-c++src'],
  ['go', 'text/x-go'],
  ['h', 'text/x-chdr'],
  ['hpp', 'text/x-c++hdr'],
  ['htm', 'text/html'],
  ['html', 'text/html'],
  ['java', 'text/x-java'],
  ['js', 'application/javascript'],
  ['json', 'application/json'],
  ['kt', 'text/x-kotlin'],
  ['markdown', 'text/markdown'],
  ['md', 'text/markdown'],
  ['mjs', 'application/javascript'],
  ['py', 'text/x-python'],
  ['rs', 'text/rust'],
  ['scss', 'text/x-scss'],
  ['sh', 'application/x-shellscript'],
  ['sql', 'application/sql'],
  ['xml', 'application/xml'],
  ['yaml', 'application/x-yaml'],
  ['yml', 'application/x-yaml'],
]);
const ubuntuSharedMimeInfo24Globs = new Map([
  ['bat', 'application/x-bat'],
  ['c', 'text/x-csrc'],
  ['cc', 'text/x-c++src'],
  ['cpp', 'text/x-c++src'],
  ['cs', 'text/x-csharp'],
  ['css', 'text/css'],
  ['cxx', 'text/x-c++src'],
  ['fish', 'application/x-fishscript'],
  ['go', 'text/x-go'],
  ['h', 'text/x-chdr'],
  ['hpp', 'text/x-c++hdr'],
  ['htm', 'text/html'],
  ['html', 'text/html'],
  ['java', 'text/x-java'],
  ['js', 'text/javascript'],
  ['json', 'application/json'],
  ['kt', 'text/x-kotlin'],
  ['markdown', 'text/markdown'],
  ['md', 'text/markdown'],
  ['mjs', 'text/javascript'],
  ['mts', 'video/mp2t'],
  ['ps1', 'application/x-powershell'],
  ['py', 'text/x-python'],
  ['rs', 'text/rust'],
  ['scss', 'text/x-scss'],
  ['sh', 'application/x-shellscript'],
  ['sql', 'application/sql'],
  ['toml', 'application/toml'],
  ['ts', 'video/mp2t'],
  ['xml', 'application/xml'],
  ['yaml', 'application/yaml'],
  ['yml', 'application/yaml'],
]);
const ubuntuSharedMimeInfoFixtures = new Map([
  ['Ubuntu 22.04 / shared-mime-info 2.1', ubuntuSharedMimeInfo21Globs],
  ['Ubuntu 24.04 / shared-mime-info 2.4', ubuntuSharedMimeInfo24Globs],
]);
const ubuntuSharedMimeInfo21YamlFixture = `<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/x-yaml">
    <comment>YAML document</comment>
    <sub-class-of type="text/plain"/>
    <magic>
      <match type="string" value="%YAML" offset="0"/>
    </magic>
    <glob pattern="*.yaml"/>
    <glob pattern="*.yml"/>
    <alias type="text/yaml"/>
    <alias type="text/x-yaml"/>
  </mime-type>
</mime-info>
`;

test('Tauri registers the approved code and workspace file associations', () => {
  const associations = config.bundle.fileAssociations ?? [];
  const extensions = associations.flatMap(({ ext }) => ext).sort();

  assert.deepEqual(associations, approvedAssociations);
  assert.deepEqual(extensions, approvedExtensions);
  assert.ok(associations.length > 0, 'expected at least one file association');
  for (const association of associations) {
    assert.equal(association.role, 'Editor');
    assert.equal(association.rank, 'Alternate');
    assert.notEqual(association.mimeType, 'text/plain');
  }
  assert.ok(!extensions.includes('txt'));
  assert.ok(!extensions.includes('log'));
});

test('the main Tauri window suspends background throttling', () => {
  const mainWindow = config.app.windows.find(({ label }) => label === 'main');

  assert.ok(mainWindow, 'expected a main Tauri window');
  assert.equal(mainWindow.backgroundThrottling, 'suspend');
});

test('the main Tauri window uses custom borderless chrome while remaining resizable', () => {
  const mainWindow = config.app.windows.find(({ label }) => label === 'main');

  assert.ok(mainWindow, 'expected a main Tauri window');
  assert.equal(mainWindow.decorations, false);
  assert.equal(mainWindow.resizable, true);
  assert.equal(mainWindow.minWidth, 1024);
  assert.equal(mainWindow.minHeight, 768);
});

test('the main Tauri window avoids transparent composition for startup efficiency', () => {
  const mainWindow = config.app.windows.find(({ label }) => label === 'main');

  assert.ok(mainWindow, 'expected a main Tauri window');
  assert.equal(mainWindow.transparent, false);
  assert.equal(mainWindow.backgroundColor, '#202020');
});

function readRequiredText(filePath, description) {
  assert.ok(fs.existsSync(filePath), `expected ${description} at ${filePath}`);
  return fs.readFileSync(filePath, 'utf8');
}

function toLinuxPath(filePath) {
  if (!isWindows) {
    return filePath;
  }
  const result = spawnSync('wsl.exe', ['-e', 'wslpath', '-a', filePath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.replaceAll('\0', '').trim();
}

function runLinuxCommand(command, args, environment) {
  const linuxArgs = args.map((argument) => (
    path.isAbsolute(argument) ? toLinuxPath(argument) : argument
  ));
  if (isWindows) {
    return spawnSync(
      'wsl.exe',
      ['-e', 'env', ...Object.entries(environment).map(([key, value]) => `${key}=${value}`), command, ...linuxArgs],
      { encoding: 'utf8' },
    );
  }
  return spawnSync(command, linuxArgs, {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

function assertLinuxCommandSucceeded(result) {
  assert.equal(
    result.status,
    0,
    `command failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
}

function cargoMainBinaryName(manifest) {
  const packageBlock = manifest.match(/^\[package\]\r?\n([\s\S]*?)(?=^\[|\s*$)/m)?.[1];
  assert.ok(packageBlock, 'Cargo manifest must contain a [package] table');
  const packageName = packageBlock.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  const defaultRun = packageBlock.match(/^default-run\s*=\s*"([^"]+)"/m)?.[1];
  assert.ok(packageName, 'Cargo [package] table must declare name');
  if (defaultRun) {
    return defaultRun;
  }

  const binaryNames = [...manifest.matchAll(/^\[\[bin\]\]\r?\n([\s\S]*?)(?=^\[|\s*$)/gm)]
    .map((match) => match[1].match(/^name\s*=\s*"([^"]+)"/m)?.[1])
    .filter(Boolean);
  return binaryNames.length === 1 ? binaryNames[0] : packageName;
}

function readNsisMacro(source, name) {
  const block = source.match(
    new RegExp(`!macro ${name}(?: [^\\r\\n]*)?\\r?\\n([\\s\\S]*?)!macroend`),
  )?.[1];
  assert.ok(block, `expected NSIS macro ${name}`);
  return block;
}

function assertNsisOwnRegistryCleanup(hooks) {
  const extensionCleanup = readNsisMacro(hooks, 'RIDE_UNREGISTER_EXTENSION');
  const uninstallCleanup = readNsisMacro(hooks, 'NSIS_HOOK_PREUNINSTALL');
  const requiredExtensionCleanup = [
    'DeleteRegValue SHCTX "Software\\Classes\\.${EXT}\\OpenWithProgids" "${RIDE_PROGID}"',
    'DeleteRegValue SHCTX "Software\\Classes\\Applications\\${MAINBINARYNAME}.exe\\SupportedTypes" ".${EXT}"',
    'DeleteRegValue SHCTX "Software\\R-IDE\\Capabilities\\FileAssociations" ".${EXT}"',
  ];
  const requiredApplicationCleanup = [
    'DeleteRegValue SHCTX "Software\\RegisteredApplications" "R-IDE"',
    'DeleteRegKey SHCTX "Software\\R-IDE\\Capabilities"',
    'DeleteRegKey SHCTX "Software\\Classes\\Applications\\${MAINBINARYNAME}.exe"',
    'DeleteRegKey SHCTX "Software\\Classes\\${RIDE_PROGID}"',
  ];

  for (const line of requiredExtensionCleanup) {
    assert.ok(extensionCleanup.includes(line), `NSIS extension cleanup must contain: ${line}`);
  }
  for (const line of requiredApplicationCleanup) {
    assert.ok(uninstallCleanup.includes(line), `NSIS uninstall cleanup must contain: ${line}`);
  }
}

function parseSharedMimeGlobs(mimePackage) {
  const globs = new Map();

  for (const mimeMatch of mimePackage.matchAll(
    /<mime-type type="([^"]+)">([\s\S]*?)<\/mime-type>/g,
  )) {
    const [, mimeType, body] = mimeMatch;
    for (const globMatch of body.matchAll(/<glob\s+([^>]*?)\/>/g)) {
      const attributes = globMatch[1];
      const extension = attributes.match(/pattern="\*\.([^"]+)"/)?.[1];
      if (!extension) {
        continue;
      }
      assert.ok(!globs.has(extension), `shared MIME package must not duplicate .${extension}`);
      globs.set(extension, {
        mimeType,
        weight: Number(attributes.match(/weight="(\d+)"/)?.[1] ?? 50),
      });
    }
  }

  return globs;
}

function assertNoLinuxDefaultHandlerWrites(source) {
  assert.doesNotMatch(source, /\bxdg-mime\s+default\b/i);
  assert.doesNotMatch(source, /mimeapps\.list/i);
}

test('Windows packaging replaces unsafe built-in associations for both installer targets', () => {
  const windowsConfig = JSON.parse(readRequiredText(windowsConfigPath, 'Windows Tauri config'));

  assert.deepEqual(windowsConfig.bundle.targets, ['nsis', 'msi']);
  assert.deepEqual(windowsConfig.bundle.fileAssociations, []);
  assert.equal(windowsConfig.bundle.windows.nsis.installerHooks, 'windows/file-associations.nsh');
  assert.deepEqual(windowsConfig.bundle.windows.wix.fragmentPaths, ['windows/file-associations.wxs']);
  assert.deepEqual(windowsConfig.bundle.windows.wix.componentRefs, ['RIDEFileAssociations']);
});

test('NSIS registers R-IDE as an alternate editor without changing extension defaults', () => {
  const hooks = readRequiredText(nsisHooksPath, 'NSIS installer hooks');
  const registeredExtensions = [
    ...hooks.matchAll(/!insertmacro RIDE_REGISTER_EXTENSION "([^"]+)"/g),
  ].map((match) => match[1]).sort();
  const unregisteredExtensions = [
    ...hooks.matchAll(/!insertmacro RIDE_UNREGISTER_EXTENSION "([^"]+)"/g),
  ].map((match) => match[1]).sort();

  assert.deepEqual(registeredExtensions, approvedExtensions);
  assert.deepEqual(unregisteredExtensions, approvedExtensions);
  assert.match(hooks, /!define RIDE_PROGID "R-IDE\.CodeFile"/);
  assert.match(hooks, /Software\\Classes\\\.\$\{EXT\}\\OpenWithProgids/);
  assert.match(hooks, /Software\\Classes\\Applications\\\$\{MAINBINARYNAME\}\.exe\\SupportedTypes/);
  assert.match(hooks, /Software\\R-IDE\\Capabilities\\FileAssociations/);
  assert.match(hooks, /Software\\RegisteredApplications/);
  assert.match(
    hooks,
    /Software\\Classes\\\$\{RIDE_PROGID\}\\shell\\open\\command" "" "\$\\"\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe\$\\" \$\\"%1\$\\""/,
  );
  assert.doesNotMatch(hooks, /APP_(?:UN)?ASSOCIATE/);
  assert.doesNotMatch(hooks, /UserChoice/);
  assert.doesNotMatch(hooks, /WriteRegStr[^\r\n]*Software\\Classes\\\.\$\{EXT\}"\s+""/);
  assert.doesNotMatch(hooks, /DeleteRegKey[^\r\n]*Software\\Classes\\\.\$\{EXT\}/);
  assert.throws(
    () => assertNsisOwnRegistryCleanup(hooks.replace(
      'DeleteRegValue SHCTX "Software\\R-IDE\\Capabilities\\FileAssociations" ".${EXT}"',
      '',
    )),
    /Capabilities\\FileAssociations/,
  );
  assertNsisOwnRegistryCleanup(hooks);
});

test('WiX registers the same R-IDE-owned Open With contract without default associations', () => {
  const fragment = readRequiredText(wixFragmentPath, 'WiX file-association fragment');
  const mainBinaryName = cargoMainBinaryName(
    readRequiredText(cargoManifestPath, 'Tauri Cargo manifest'),
  );
  const wixMainBinaryName = fragment.match(
    /<\?define RIDEMainBinaryName = "([^"]+)\.exe" \?>/,
  )?.[1];
  const openWithExtensions = [
    ...fragment.matchAll(/Key="Software\\Classes\\\.([^\\"]+)\\OpenWithProgids"/g),
  ].map((match) => match[1]).sort();
  const supportedTypesBlock = fragment.match(
    new RegExp(`<RegistryKey Root="HKLM" Key="Software\\\\Classes\\\\Applications\\\\\\$\\(var\\.RIDEMainBinaryName\\)\\\\SupportedTypes">([\\s\\S]*?)<\\/RegistryKey>`),
  )?.[1];
  const capabilitiesBlock = fragment.match(
    /<RegistryKey Root="HKLM" Key="Software\\R-IDE\\Capabilities\\FileAssociations">([\s\S]*?)<\/RegistryKey>/,
  )?.[1];

  assert.deepEqual(openWithExtensions, approvedExtensions);
  assert.equal(wixMainBinaryName, mainBinaryName);
  assert.ok(
    supportedTypesBlock,
    `WiX must declare Applications/${mainBinaryName}.exe/SupportedTypes through RIDEMainBinaryName`,
  );
  assert.ok(capabilitiesBlock, 'WiX must declare R-IDE Capabilities/FileAssociations');
  assert.deepEqual(
    [...supportedTypesBlock.matchAll(/<RegistryValue Name="\.([^"]+)"/g)].map((match) => match[1]).sort(),
    approvedExtensions,
  );
  assert.deepEqual(
    [...capabilitiesBlock.matchAll(/<RegistryValue Name="\.([^"]+)"/g)].map((match) => match[1]).sort(),
    approvedExtensions,
  );
  assert.match(fragment, /Id="RIDEFileAssociations"/);
  assert.match(fragment, /Key="Software\\Classes\\R-IDE\.CodeFile"/);
  assert.match(fragment, /Key="Software\\RegisteredApplications"/);
  assert.match(fragment, /Value="&quot;\[!Path\]&quot; &quot;%1&quot;"/);
  assert.doesNotMatch(fragment, /<Extension\b/);
  assert.doesNotMatch(fragment, /UserChoice|ForceDeleteOnUninstall/);
});

test('Linux packaging installs MIME metadata and safe desktop entries for every target', () => {
  const linuxConfig = JSON.parse(readRequiredText(linuxConfigPath, 'Linux Tauri config'));
  const mimeDestination = '/usr/share/mime/packages/r-ide.xml';
  const mimeSource = 'linux/r-ide-mime.xml';

  assert.deepEqual(linuxConfig.bundle.targets, ['deb', 'rpm', 'appimage']);
  assert.equal(linuxConfig.bundle.linux.deb.desktopTemplate, 'linux/r-ide.desktop');
  assert.equal(linuxConfig.bundle.linux.rpm.desktopTemplate, 'linux/r-ide.desktop');
  assert.equal(linuxConfig.bundle.linux.deb.files[mimeDestination], mimeSource);
  assert.equal(linuxConfig.bundle.linux.rpm.files[mimeDestination], mimeSource);
  assert.equal(linuxConfig.bundle.linux.appimage.files[mimeDestination], mimeSource);
  assert.equal(
    linuxConfig.bundle.linux.appimage.files['/usr/share/applications/R-IDE.desktop'],
    'linux/r-ide-appimage.desktop',
  );
  for (const target of ['deb', 'rpm']) {
    assert.equal(linuxConfig.bundle.linux[target].postInstallScript, 'linux/update-mime-database.sh');
    assert.equal(linuxConfig.bundle.linux[target].postRemoveScript, 'linux/update-mime-database.sh');
  }
});

test('Linux desktop sources pass multiple files without unsafe URI interpretation', () => {
  const desktopTemplate = readRequiredText(linuxDesktopTemplatePath, 'Linux desktop template');
  const appImageDesktop = readRequiredText(appImageDesktopPath, 'AppImage desktop entry');
  const expectedMimeList = `${approvedAssociations.map(({ mimeType }) => mimeType).join(';')};`;

  assert.match(desktopTemplate, /^Exec=\{\{exec\}\} %F$/m);
  assert.match(desktopTemplate, /^MimeType=\{\{mime_type\}\};$/m);
  assert.doesNotMatch(desktopTemplate, /^Exec=.*%[fuU]$/m);
  assert.match(appImageDesktop, /^Exec=ride-tauri %F$/m);
  assert.match(appImageDesktop, new RegExp(`^MimeType=${expectedMimeList.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.doesNotMatch(appImageDesktop, /^Exec=.*%[fuU]$/m);
});

test('Linux packaging never writes a default MIME handler', () => {
  const linuxSources = [
    readRequiredText(linuxConfigPath, 'Linux Tauri config'),
    readRequiredText(linuxDesktopTemplatePath, 'Linux desktop template'),
    readRequiredText(appImageDesktopPath, 'AppImage desktop entry'),
    readRequiredText(linuxMimePackagePath, 'R-IDE shared MIME package'),
    readRequiredText(linuxMimeUpdateScriptPath, 'shared MIME cache update script'),
    readRequiredText(appImageIntegrationScriptPath, 'AppImage integration script'),
  ].join('\n');

  assert.throws(
    () => assertNoLinuxDefaultHandlerWrites(`${linuxSources}\nxdg-mime default R-IDE.desktop text/plain`),
    /xdg-mime/,
  );
  assert.throws(
    () => assertNoLinuxDefaultHandlerWrites(`${linuxSources}\nmimeapps.list`),
    /mimeapps/,
  );
  assertNoLinuxDefaultHandlerWrites(linuxSources);
});

test('R-IDE shared MIME metadata covers every Ubuntu 2.1 and 2.4 mapping gap', () => {
  const mimePackage = readRequiredText(linuxMimePackagePath, 'R-IDE shared MIME package');
  const supplementalGlobs = parseSharedMimeGlobs(mimePackage);
  const expectedSupplementalExtensions = [];

  for (const { ext: extensions, mimeType } of approvedAssociations) {
    for (const extension of extensions) {
      const incompatibleFixtures = [...ubuntuSharedMimeInfoFixtures]
        .filter(([, globs]) => globs.get(extension) !== mimeType)
        .map(([name]) => name);
      if (incompatibleFixtures.length === 0) {
        assert.ok(
          !supplementalGlobs.has(extension),
          `.${extension} already has the approved ${mimeType} mapping in every Ubuntu fixture`,
        );
      } else {
        expectedSupplementalExtensions.push(extension);
        assert.deepEqual(
          supplementalGlobs.get(extension),
          { mimeType, weight: 80 },
          `.${extension} must provide ${mimeType} for ${incompatibleFixtures.join(', ')}`,
        );
      }
    }
  }
  assert.deepEqual([...supplementalGlobs.keys()].sort(), expectedSupplementalExtensions.sort());
  assert.doesNotMatch(mimePackage, /<mime-type type="text\/plain"/);

  const updateScript = readRequiredText(linuxMimeUpdateScriptPath, 'shared MIME cache update script');
  assert.match(updateScript, /command -v update-mime-database/);
  assert.match(updateScript, /update-mime-database \/usr\/share\/mime/);
  assert.doesNotMatch(updateScript, /sudo/);
});

test('Ubuntu 22.04 resolves non-empty YAML files to the approved application/yaml type', (context) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'r-ide ubuntu-22.04-yaml '));
  context.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const dataHome = path.join(sandbox, 'data-home');
  const dataDirectories = path.join(sandbox, 'data-directories');
  const mimeDirectory = path.join(dataHome, 'mime');
  const packagesDirectory = path.join(mimeDirectory, 'packages');
  fs.mkdirSync(packagesDirectory, { recursive: true });
  fs.mkdirSync(dataDirectories, { recursive: true });
  fs.writeFileSync(
    path.join(packagesDirectory, 'ubuntu-shared-mime-info-2.1-yaml.xml'),
    ubuntuSharedMimeInfo21YamlFixture,
  );
  fs.copyFileSync(linuxMimePackagePath, path.join(packagesDirectory, 'r-ide.xml'));
  const environment = {
    HOME: toLinuxPath(sandbox),
    XDG_DATA_HOME: toLinuxPath(dataHome),
    XDG_DATA_DIRS: toLinuxPath(dataDirectories),
    LC_ALL: 'C',
  };

  assertLinuxCommandSucceeded(runLinuxCommand(
    'update-mime-database',
    [mimeDirectory],
    environment,
  ));
  for (const extension of ['yaml', 'yml']) {
    const documentPath = path.join(sandbox, `non-empty.${extension}`);
    fs.writeFileSync(documentPath, 'project: R-IDE\n');
    const result = runLinuxCommand(
      'gio',
      ['info', '--attributes=standard::content-type', documentPath],
      environment,
    );
    assertLinuxCommandSucceeded(result);
    assert.match(
      result.stdout.replaceAll('\0', ''),
      /standard::content-type: application\/yaml\b/,
      `.${extension} must resolve to application/yaml with Ubuntu shared-mime-info 2.1 rules`,
    );
  }
});
