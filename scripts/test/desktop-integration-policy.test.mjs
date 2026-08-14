import assert from 'node:assert/strict';
import fs from 'node:fs';
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

const editorAssociation = { role: 'Editor', rank: 'Alternate' };
const approvedAssociations = [
  { ext: ['bash', 'sh', 'zsh'], mimeType: 'text/x-shellscript', name: 'Shell Script', description: 'Shell script source file', ...editorAssociation },
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

function readRequiredText(filePath, description) {
  assert.ok(fs.existsSync(filePath), `expected ${description} at ${filePath}`);
  return fs.readFileSync(filePath, 'utf8');
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
});

test('WiX registers the same R-IDE-owned Open With contract without default associations', () => {
  const fragment = readRequiredText(wixFragmentPath, 'WiX file-association fragment');
  const openWithExtensions = [
    ...fragment.matchAll(/Key="Software\\Classes\\\.([^\\"]+)\\OpenWithProgids"/g),
  ].map((match) => match[1]).sort();
  const supportedTypesBlock = fragment.match(
    /<RegistryKey Root="HKLM" Key="Software\\Classes\\Applications\\ride-tauri\.exe\\SupportedTypes">([\s\S]*?)<\/RegistryKey>/,
  )?.[1];
  const capabilitiesBlock = fragment.match(
    /<RegistryKey Root="HKLM" Key="Software\\R-IDE\\Capabilities\\FileAssociations">([\s\S]*?)<\/RegistryKey>/,
  )?.[1];

  assert.deepEqual(openWithExtensions, approvedExtensions);
  assert.ok(supportedTypesBlock, 'WiX must declare Applications/ride-tauri.exe/SupportedTypes');
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

test('R-IDE shared MIME metadata only fills extension gaps in the system database', () => {
  const mimePackage = readRequiredText(linuxMimePackagePath, 'R-IDE shared MIME package');
  const expectedSupplementalGlobs = new Map([
    ['text/x-shellscript', ['bash', 'zsh']],
    ['application/x-powershell', ['psm1']],
    ['text/x-kotlin', ['kts']],
    ['text/x-python', ['pyw']],
    ['text/x-r-source', ['r']],
    ['text/x-r-ide-r-markdown', ['rmd']],
    ['text/x-r-ide-quarto', ['qmd']],
    ['text/x-r-ide-less', ['less']],
    ['text/x-r-ide-jsx', ['jsx']],
    ['text/x-r-ide-typescript-jsx', ['tsx']],
    ['text/x-r-ide-svelte', ['svelte']],
    ['text/x-r-ide-vue', ['vue']],
    ['application/x-r-ide-jsonc', ['jsonc']],
    ['application/x-r-ide-workspace', ['code-workspace', 'theia-workspace']],
    ['text/x-r-ide-ini', ['ini']],
    ['text/x-r-ide-properties', ['properties']],
  ]);

  for (const [mimeType, extensions] of expectedSupplementalGlobs) {
    const escapedMimeType = mimeType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const block = mimePackage.match(
      new RegExp(`<mime-type type="${escapedMimeType}">([\\s\\S]*?)<\\/mime-type>`),
    )?.[1];
    assert.ok(block, `shared MIME package must declare ${mimeType}`);
    assert.deepEqual(
      [...block.matchAll(/<glob pattern="\*\.([^"]+)"/g)].map((match) => match[1]).sort(),
      [...extensions].sort(),
    );
  }
  assert.doesNotMatch(mimePackage, /<mime-type type="text\/plain"/);

  const updateScript = readRequiredText(linuxMimeUpdateScriptPath, 'shared MIME cache update script');
  assert.match(updateScript, /command -v update-mime-database/);
  assert.match(updateScript, /update-mime-database \/usr\/share\/mime/);
  assert.doesNotMatch(updateScript, /sudo/);
});
