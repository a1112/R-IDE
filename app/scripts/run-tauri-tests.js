/* Run Tauri Rust tests on Windows after adding the Common Controls v6 manifest.
 *
 * Tauri's generated resource library is linked only into binary targets. Rust's
 * lib test harness therefore has no application manifest and fails at process
 * startup when wry imports TaskDialogIndirect from comctl32.dll. Building test
 * executables first lets us add the same activation context before running them.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const appRoot = path.resolve(__dirname, '..');
const manifestPath = 'applications/tauri/src-tauri/Cargo.toml';

const commonControlsManifest = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
`;

function parseTestExecutables(output) {
  const executables = new Set();
  for (const line of output.split(/\r?\n/)) {
    try {
      const message = JSON.parse(line);
      if (
        message.reason === 'compiler-artifact'
        && message.profile?.test === true
        && typeof message.executable === 'string'
      ) {
        executables.add(message.executable);
      }
    } catch {
      // Cargo progress and third-party tools may emit non-JSON lines.
    }
  }
  return [...executables];
}

function windowsSdkArchitecture(architecture) {
  switch (architecture) {
    case 'x64':
    case 'arm64':
      return architecture;
    case 'ia32':
      return 'x86';
    default:
      throw new Error(`Unsupported Windows architecture: ${architecture}`);
  }
}

function findMtExecutable() {
  if (process.env.RIDE_WINDOWS_MT && fs.existsSync(process.env.RIDE_WINDOWS_MT)) {
    return process.env.RIDE_WINDOWS_MT;
  }

  const where = spawnSync('where.exe', ['mt.exe'], {
    encoding: 'utf8',
    shell: false,
  });
  if (where.status === 0) {
    const first = where.stdout.split(/\r?\n/).find(candidate => candidate.trim());
    if (first) {
      return first.trim();
    }
  }

  const programFilesX86 = process.env['ProgramFiles(x86)'];
  if (!programFilesX86) {
    throw new Error('Cannot locate the Windows SDK: ProgramFiles(x86) is unavailable.');
  }

  const sdkBin = path.join(programFilesX86, 'Windows Kits', '10', 'bin');
  const architecture = windowsSdkArchitecture(process.arch);
  const versions = fs.readdirSync(sdkBin, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));

  for (const version of versions) {
    const candidate = path.join(sdkBin, version, architecture, 'mt.exe');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'Cannot locate mt.exe. Install the Windows SDK or set RIDE_WINDOWS_MT to its path.',
  );
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: appRoot,
    env: process.env,
    shell: false,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const error = new Error(`${path.basename(command)} exited with code ${result.status ?? 1}`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
  return result;
}

function injectManifest(mtExecutable, testExecutable, manifestFile) {
  runCommand(mtExecutable, [
    '-nologo',
    '-manifest',
    manifestFile,
    `-outputresource:${testExecutable};#1`,
  ]);
}

function printCargoDiagnostics(output) {
  for (const line of output.split(/\r?\n/)) {
    try {
      const message = JSON.parse(line);
      if (message.reason === 'compiler-message' && message.message?.rendered) {
        process.stderr.write(message.message.rendered);
      }
    } catch {
      // Ignore non-JSON output; Cargo already wrote progress to stderr.
    }
  }
}

function runTauriTests(testArguments = process.argv.slice(2)) {
  const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  if (process.platform !== 'win32') {
    runCommand(cargo, ['test', '--manifest-path', manifestPath, '--', ...testArguments]);
    return 0;
  }

  const build = spawnSync(cargo, [
    'test',
    '--manifest-path',
    manifestPath,
    '--no-run',
    '--message-format=json',
  ], {
    cwd: appRoot,
    env: process.env,
    encoding: 'utf8',
    shell: false,
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  if (build.error) {
    throw build.error;
  }
  if (build.status !== 0) {
    printCargoDiagnostics(build.stdout);
    const error = new Error(`cargo.exe exited with code ${build.status ?? 1}`);
    error.exitCode = build.status ?? 1;
    throw error;
  }

  const testExecutables = parseTestExecutables(build.stdout);
  if (testExecutables.length === 0) {
    throw new Error('Cargo did not produce any Rust test executables.');
  }

  const mtExecutable = findMtExecutable();
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-rust-tests-'));
  const manifestFile = path.join(temporaryDirectory, 'CommonControls.manifest');
  fs.writeFileSync(manifestFile, commonControlsManifest, 'utf8');
  try {
    for (const executable of testExecutables) {
      injectManifest(mtExecutable, executable, manifestFile);
      runCommand(executable, testArguments);
    }
    runCommand(cargo, [
      'test',
      '--manifest-path',
      manifestPath,
      '--doc',
      '--',
      ...testArguments,
    ]);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  return 0;
}

if (require.main === module) {
  try {
    runTauriTests();
  } catch (error) {
    console.error(`Tauri Rust tests failed: ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  }
}

module.exports = {
  commonControlsManifest,
  findMtExecutable,
  parseTestExecutables,
  runTauriTests,
  windowsSdkArchitecture,
};
