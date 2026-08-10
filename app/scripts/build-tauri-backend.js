/*
 * Cross-platform Tauri backend build entry point.
 *
 * The previous package script used POSIX shell environment-prefix syntax,
 * which is not understood by cmd.exe or PowerShell. Keep process invocation
 * explicit so the same script works on every supported platform.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const browserDirectory = path.resolve(__dirname, '..', 'applications', 'browser');

function createBuildPlan(platform = process.platform) {
  const yarn = platform === 'win32' ? 'yarn.cmd' : 'yarn';
  const inheritedEnvironment = { ...process.env };

  return [
    {
      command: yarn,
      args: ['run', 'rebuild', '--silent'],
      cwd: browserDirectory,
      env: inheritedEnvironment,
      shell: false,
    },
    {
      command: yarn,
      args: ['theia', 'build', '--app-target=browser'],
      cwd: browserDirectory,
      env: { ...inheritedEnvironment, RIDE_TAURI_LEAN: '1' },
      shell: false,
    },
  ];
}

function runBuild(platform = process.platform) {
  for (const step of createBuildPlan(platform)) {
    const result = spawnSync(step.command, step.args, {
      cwd: step.cwd,
      env: step.env,
      shell: step.shell,
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
    runBuild();
  } catch (error) {
    console.error(`Tauri backend build failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { browserDirectory, createBuildPlan, runBuild };
