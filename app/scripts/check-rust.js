/* Run the Rust quality gates without shell-specific command chaining. */

const { spawnSync } = require('node:child_process');

const cargoArguments = [
  ['fmt', '--manifest-path', 'applications/tauri/src-tauri/Cargo.toml', '--check'],
  ['clippy', '--manifest-path', 'applications/tauri/src-tauri/Cargo.toml', '--all-targets', '--', '-D', 'warnings'],
  ['test', '--manifest-path', 'applications/tauri/src-tauri/Cargo.toml'],
];

function run() {
  for (const args of cargoArguments) {
    const result = spawnSync(process.platform === 'win32' ? 'cargo.exe' : 'cargo', args, {
      cwd: __dirname + '/..',
      env: process.env,
      shell: false,
      stdio: 'inherit',
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      return result.status;
    }
  }
  return 0;
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(`Rust checks failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { cargoArguments, run };
