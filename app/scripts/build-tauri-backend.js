/*
 * Cross-platform entry point for the generated Tauri browser application.
 * The tracked browser application is only an immutable source template; all
 * Theia generation and bundling happens below .ride-tauri-profile.
 */

const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const browserDirectory = path.resolve(__dirname, '..', 'applications', 'browser');
const appDirectory = path.resolve(browserDirectory, '..', '..');
const profileDirectory = path.join(browserDirectory, '.ride-tauri-profile');
const profileScript = path.resolve(__dirname, 'tauri-frontend-profile.mjs');
const theiaCli = require.resolve('@theia/cli/bin/theia.js', { paths: [browserDirectory] });
const supportedProfiles = new Set(['tauri-critical', 'full']);

function resolveProfileName(profile, environment) {
  const selected = profile ?? environment.RIDE_TAURI_FRONTEND_PROFILE ?? 'tauri-critical';
  if (!supportedProfiles.has(selected)) {
    throw new Error(`Unknown Tauri frontend profile "${selected}".`);
  }
  return selected;
}

function createBuildPlan(platform = process.platform, profile, environment = process.env, options = {}) {
  const selectedProfile = resolveProfileName(profile, environment);
  const buildId = (options.buildIdFactory ?? crypto.randomUUID)();
  if (typeof buildId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(buildId)) {
    throw new Error(`Tauri profile build id "${buildId}" is not canonical.`);
  }
  const buildDirectory = path.join(profileDirectory, 'builds', buildId);
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(environment).filter(([name]) => !/^RIDE_TAURI_(?:LEAN|ENABLE_PLUGINS)$/.test(name)),
  );
  const buildEnvironment = {
    ...inheritedEnvironment,
    RIDE_TAURI_FRONTEND_PROFILE: selectedProfile,
    RIDE_TAURI_BUILD_ID: buildId,
  };

  return [
    {
      command: process.execPath,
      args: [profileScript, 'prepare', '--profile', selectedProfile, '--build-id', buildId],
      cwd: browserDirectory,
      env: buildEnvironment,
      shell: false,
    },
    {
      command: process.execPath,
      args: [theiaCli, 'rebuild:browser', '--cacheRoot', appDirectory],
      cwd: buildDirectory,
      env: buildEnvironment,
      shell: false,
    },
    {
      command: process.execPath,
      args: [theiaCli, 'build', '--app-target=browser'],
      cwd: buildDirectory,
      env: buildEnvironment,
      shell: false,
    },
    {
      command: process.execPath,
      args: [
        profileScript,
        'publish',
        '--profile', selectedProfile,
        '--build-id', buildId,
        '--source-dir', buildDirectory,
      ],
      cwd: browserDirectory,
      env: buildEnvironment,
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
  if (platform !== 'win32' || path.resolve(step.command) === path.resolve(process.execPath)) {
    return { command: step.command, args: step.args };
  }

  const comspec = step.env.ComSpec || step.env.COMSPEC || process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  const commandLine = [step.command, ...step.args].map(quoteCmdArg).join(' ');
  return { command: comspec, args: ['/d', '/s', '/c', commandLine] };
}

function runBuild(platform = process.platform, spawn = spawnSync, profile, environment = process.env) {
  for (const step of createBuildPlan(platform, profile, environment)) {
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
      return result.status ?? 1;
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

module.exports = {
  browserDirectory,
  profileDirectory,
  createBuildPlan,
  createSpawnInvocation,
  runBuild,
};
