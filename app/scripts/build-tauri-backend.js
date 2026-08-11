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
      args: ['run', 'rebuild'],
      cwd: browserDirectory,
      env: inheritedEnvironment,
      shell: false,
    },
    {
      command: yarn,
      args: ['theia', 'build', '--app-target=browser'],
      cwd: browserDirectory,
      env: {
        ...inheritedEnvironment,
        RIDE_TAURI_ENABLE_PLUGINS: '1',
        RIDE_TAURI_LEAN: '1',
      },
      shell: false,
    },
  ];
}

function quoteCmdArg(value) {
  const stringValue = String(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(stringValue)) {
    return stringValue;
  }
  return `"${stringValue.replace(/["^&|<>!]/g, character => `^${character}`).replace(/%/g, '^%')}"`;
}

function createSpawnInvocation(step, platform) {
  if (platform !== 'win32') {
    return { command: step.command, args: step.args };
  }

  const comspec = step.env.ComSpec || step.env.COMSPEC || process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  const commandLine = [step.command, ...step.args].map(quoteCmdArg).join(' ');
  return { command: comspec, args: ['/d', '/s', '/c', commandLine] };
}

function runBuild(platform = process.platform, spawn = spawnSync) {
  for (const step of createBuildPlan(platform)) {
    const invocation = createSpawnInvocation(step, platform);
    const result = spawn(invocation.command, invocation.args, {
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

module.exports = { browserDirectory, createBuildPlan, createSpawnInvocation, runBuild };
