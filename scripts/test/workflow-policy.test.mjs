import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'ci.yml');

function readWorkflow() {
  assert.ok(fs.existsSync(workflowPath), `expected workflow at ${workflowPath}`);
  return fs.readFileSync(workflowPath, 'utf8');
}

function jobBlocks(workflow) {
  const jobsSection = workflow.split(/^jobs:\s*$/m)[1];
  assert.ok(jobsSection, 'workflow must define jobs');
  return [...jobsSection.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)].map((match, index, jobs) => {
    const start = match.index;
    const end = jobs[index + 1]?.index ?? jobsSection.length;
    return { name: match[1], text: jobsSection.slice(start, end) };
  });
}

test('CI workflow has least-privilege triggers and concurrency controls', () => {
  const workflow = readWorkflow();
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
  assert.match(workflow, /^on:\s*$/m);
  assert.match(workflow, /^\s+push:\s*$/m);
  assert.match(workflow, /^\s+pull_request:\s*$/m);
  assert.match(workflow, /^\s+workflow_dispatch:\s*$/m);
  assert.match(workflow, /^concurrency:\s*\n\s+group:/m);
  assert.match(workflow, /cancel-in-progress:\s*true/);
});

test('every CI job has an explicit timeout and required quality jobs exist', () => {
  const workflow = readWorkflow();
  const jobs = jobBlocks(workflow);
  assert.ok(jobs.length >= 3, 'expected quality, compatibility, and package jobs');
  for (const job of jobs) {
    assert.match(job.text, /timeout-minutes:\s*\d+/);
  }
  assert.ok(jobs.some(({ name }) => name === 'quality'));
  assert.ok(jobs.some(({ name }) => name === 'upstream-compatibility'));
  assert.ok(jobs.some(({ name }) => name === 'package'));
});

test('package matrix covers all supported desktop runners and Node 22', () => {
  const workflow = readWorkflow();
  const packageJob = jobBlocks(workflow).find(({ name }) => name === 'package');
  assert.ok(packageJob, 'package job is required');
  for (const runner of ['windows-2022', 'ubuntu-22.04', 'macos-15', 'macos-15-intel']) {
    assert.match(packageJob.text, new RegExp(`os:\\s*${runner.replace('.', '\\.')}`));
  }
  assert.match(packageJob.text, /node-version:\s*['"]?22(?:\.x)?['"]?/);
  assert.match(packageJob.text, /rustup\s+toolchain\s+install\s+stable/);
  assert.match(packageJob.text, /npm --workspace applications\/tauri run verify/);
});

test('package jobs download VS Code plugins before building the verified bundle', () => {
  const workflow = readWorkflow();
  const packageJob = jobBlocks(workflow).find(({ name }) => name === 'package');
  assert.ok(packageJob, 'package job is required');
  assert.match(packageJob.text, /app\/plugins/);
  const downloadIndex = packageJob.text.indexOf('yarn download:plugins');
  const buildIndex = packageJob.text.indexOf('run: yarn build:tauri');
  assert.ok(downloadIndex >= 0, 'package job must download plugins');
  assert.ok(buildIndex > downloadIndex, 'plugins must be available before the Tauri build');
});

test('packaged Tauri builds preserve the complete plugin dependency graph', () => {
  const workflow = readWorkflow();
  const packageJob = jobBlocks(workflow).find(({ name }) => name === 'package');
  assert.ok(packageJob, 'package job is required');
  assert.match(packageJob.text, /run: yarn build:tauri/);

  const buildHelper = fs.readFileSync(
    path.join(repositoryRoot, 'app', 'scripts', 'build-tauri-backend.js'),
    'utf8'
  );
  assert.match(buildHelper, /RIDE_TAURI_ENABLE_PLUGINS:\s*['"]1['"]/);
  assert.match(buildHelper, /RIDE_TAURI_LEAN:\s*['"]0['"]/);
  assert.doesNotMatch(buildHelper, /RIDE_TAURI_LEAN:\s*['"](?:1|true)['"]/);
});

test('package jobs measure startup after verification and upload the unsigned JSON report', () => {
  const workflow = readWorkflow();
  const packageJob = jobBlocks(workflow).find(({ name }) => name === 'package');
  assert.ok(packageJob, 'package job is required');
  const verifyIndex = packageJob.text.indexOf('- name: Verify the packaged Tauri application');
  const linuxMeasureIndex = packageJob.text.indexOf('- name: Measure packaged Tauri startup on Linux');
  const desktopMeasureIndex = packageJob.text.indexOf('- name: Measure packaged Tauri startup on non-Linux');
  const uploadIndex = packageJob.text.indexOf('- name: Upload unsigned native bundles');
  assert.ok(verifyIndex >= 0, 'package job must verify the bundle');
  assert.ok(linuxMeasureIndex > verifyIndex, 'Linux measurement must follow bundle verification');
  assert.ok(desktopMeasureIndex > verifyIndex, 'desktop measurement must follow bundle verification');
  assert.ok(uploadIndex > linuxMeasureIndex && uploadIndex > desktopMeasureIndex,
    'startup reports must be generated before artifact upload');

  const measurementBlock = packageJob.text.slice(linuxMeasureIndex, uploadIndex);
  assert.match(measurementBlock, /if:\s*runner\.os\s*==\s*['"]Linux['"]/);
  assert.match(measurementBlock, /if:\s*runner\.os\s*!=\s*['"]Linux['"]/);
  assert.match(measurementBlock, /xvfb-run\s+-a\s+npm\s+run\s+measure:tauri-startup/);
  assert.match(measurementBlock, /npm\s+run\s+measure:tauri-startup/);
  assert.match(measurementBlock, /--output\s+applications\/tauri\/src-tauri\/target\/release\/bundle\/startup-metrics\.json/);

  const uploadBlock = packageJob.text.slice(uploadIndex);
  assert.match(uploadBlock, /if:\s*always\(\)/);
  assert.match(uploadBlock, /path:\s*app\/applications\/tauri\/src-tauri\/target\/release\/bundle\/\*\*/);

  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'app', 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts?.['measure:tauri-startup'], 'node scripts/measure-tauri-startup.mjs');
});

test('macOS package builds retry transient DMG bundling failures once', () => {
  const workflow = readWorkflow();
  const packageJob = jobBlocks(workflow).find(({ name }) => name === 'package');
  assert.ok(packageJob, 'package job is required');
  const retryIndex = packageJob.text.indexOf("if: runner.os == 'macOS'");
  const verifyIndex = packageJob.text.indexOf('- name: Verify the packaged Tauri application');
  assert.ok(retryIndex >= 0, 'package job must define a macOS build step');
  assert.ok(verifyIndex > retryIndex, 'macOS build must complete before verification');
  const macBuild = packageJob.text.slice(retryIndex, verifyIndex);
  assert.match(macBuild, /yarn build:tauri[\s\S]*yarn build:tauri/);
  assert.match(macBuild, /set -o pipefail/);
  assert.match(macBuild, /mktemp/);
  assert.match(macBuild, /grep -Eqi ['"]hdiutil\|bundle_dmg\\\.sh['"]/);
  assert.match(macBuild, /non-transient reason/i);
  assert.match(macBuild, /retrying once/i);
});

test('quality and compatibility jobs run the required Node builds and Rust checks', () => {
  const workflow = readWorkflow();
  const jobs = Object.fromEntries(jobBlocks(workflow).map(({ name, text }) => [name, text]));
  assert.match(jobs.quality, /node --test scripts\/test\/upstream-sync\/\*\.test\.mjs scripts\/test\/workflow-policy\.test\.mjs/);
  assert.match(jobs.quality, /node --test[^\n]*scripts\/test\/desktop-integration-policy\.test\.mjs/);
  assert.match(jobs.quality, /node --test[^\n]*scripts\/test\/appimage-integration\.test\.mjs/);
  assert.match(jobs.quality, /node --test[^\n]*app\/scripts\/test\/tauri-permissions\.test\.mjs/);
  assert.match(jobs.quality, /npm --workspace theia-extensions\/product test/);
  assert.match(jobs.quality, /yarn lint/);
  assert.match(jobs.quality, /yarn build:extensions/);
  assert.match(jobs.quality, /yarn browser build/);
  assert.match(jobs.quality, /cargo fmt --manifest-path applications\/tauri\/src-tauri\/Cargo\.toml --check/);
  assert.match(jobs.quality, /cargo clippy --manifest-path applications\/tauri\/src-tauri\/Cargo\.toml --all-targets -- -D warnings/);
  assert.match(jobs.quality, /cargo test --manifest-path applications\/tauri\/src-tauri\/Cargo\.toml/);
  assert.match(jobs['upstream-compatibility'], /node-version:\s*['"]?24(?:\.x)?['"]?/);
  assert.match(jobs['upstream-compatibility'], /yarn build:extensions/);
  assert.match(jobs['upstream-compatibility'], /yarn browser build/);
});

test('all third-party actions are pinned to approved full commit SHAs', () => {
  const workflow = readWorkflow();
  const uses = [...workflow.matchAll(/^\s+uses:\s*([^\s#]+)\s*$/gm)].map((match) => match[1]);
  assert.ok(uses.length > 0, 'workflow should use pinned official actions');
  const allowed = new Set([
    'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
    'actions/setup-node@6044e13b5dc448c55e2357c09f80417699197238',
    'actions/cache@caa296126883cff596d87d8935842f9db880ef25',
    'actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f',
  ]);
  for (const action of uses) {
    assert.ok(allowed.has(action), `unexpected or unpinned action ${action}`);
    assert.match(action, /@[0-9a-f]{40}$/);
  }
});

test('CI only validates and packages unsigned bundles without release automation', () => {
  const workflow = readWorkflow();
  assert.doesNotMatch(workflow, /(?:^|\n)\s*(?:release|signing):|gh\s+release|codesign|signtool|auto[- ]?merge/i);
  assert.match(workflow, /app\/applications\/tauri\/src-tauri\/target\/release\/bundle\/\*\*/);
  assert.match(workflow, /name:\s*tauri-\$\{\{\s*matrix\.platform\s*\}\}-\$\{\{\s*matrix\.arch\s*\}\}/);
});

test('workspace dependencies resolve to the local workspace version', () => {
  const workspaceRoot = path.join(repositoryRoot, 'app');
  const packageDirectories = [
    path.join(workspaceRoot, 'applications'),
    path.join(workspaceRoot, 'theia-extensions'),
  ];
  const packages = new Map();
  const packageFiles = [];
  for (const directory of packageDirectories) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageFile = path.join(directory, entry.name, 'package.json');
      if (!fs.existsSync(packageFile)) {
        continue;
      }
      const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
      packageFiles.push({ packageFile, packageJson });
      packages.set(packageJson.name, packageJson.version);
    }
  }

  for (const { packageFile, packageJson } of packageFiles) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [dependency, declaredVersion] of Object.entries(packageJson[field] ?? {})) {
        const workspaceVersion = packages.get(dependency);
        if (workspaceVersion === undefined) {
          continue;
        }
        assert.equal(
          declaredVersion,
          workspaceVersion,
          `${packageJson.name} declares ${dependency}@${declaredVersion}, but the local workspace is ${workspaceVersion} (${packageFile})`,
        );
      }
    }
  }
});

test('Linux Tauri prerequisites avoid conflicting AppIndicator development packages', () => {
  const workflow = readWorkflow();
  assert.match(workflow, /\blibayatana-appindicator3-dev\b/);
  assert.doesNotMatch(workflow, /(?:^|\n)\s*libappindicator3-dev\s*\\/m);
  const qualityJob = jobBlocks(workflow).find(({ name }) => name === 'quality');
  const packageJob = jobBlocks(workflow).find(({ name }) => name === 'package');
  assert.ok(qualityJob, 'quality job is required');
  assert.ok(packageJob, 'package job is required');
  assert.doesNotMatch(qualityJob.text, /\bxvfb\b/);

  const prerequisiteIndex = packageJob.text.indexOf('- name: Install Linux Tauri prerequisites');
  const rustIndex = packageJob.text.indexOf('- name: Install Rust stable toolchain');
  assert.ok(prerequisiteIndex >= 0, 'package job must install Linux prerequisites');
  assert.ok(rustIndex > prerequisiteIndex, 'package prerequisites must precede Rust setup');
  const packagePrerequisites = packageJob.text.slice(prerequisiteIndex, rustIndex);
  assert.match(packagePrerequisites, /\bxvfb\b/);

  const measurementIndex = packageJob.text.indexOf('- name: Measure packaged Tauri startup on Linux');
  const nonLinuxIndex = packageJob.text.indexOf('- name: Measure packaged Tauri startup on non-Linux');
  assert.ok(measurementIndex >= 0 && nonLinuxIndex > measurementIndex,
    'package job must define the Linux measurement block');
  const linuxMeasurement = packageJob.text.slice(measurementIndex, nonLinuxIndex);
  assert.match(linuxMeasurement, /xvfb-run\s+-a\s+npm\s+run\s+measure:tauri-startup/);
});

test('quality job installs Linux Tauri prerequisites before Rust checks', () => {
  const workflow = readWorkflow();
  const quality = jobBlocks(workflow).find(({ name }) => name === 'quality');
  assert.ok(quality, 'quality job is required');
  const prerequisiteIndex = quality.text.indexOf('- name: Install Linux Tauri prerequisites');
  const rustIndex = quality.text.indexOf('- name: Install Rust stable toolchain');
  assert.ok(prerequisiteIndex >= 0, 'quality job must install Linux Tauri prerequisites');
  assert.ok(rustIndex > prerequisiteIndex, 'Linux prerequisites must be installed before Rust checks');
  const prerequisites = quality.text.slice(prerequisiteIndex, rustIndex);
  assert.match(prerequisites, /if:\s*runner\.os\s*==\s*['"]?Linux['"]?/);
  assert.match(prerequisites, /libwebkit2gtk-4\.1-dev/);
  assert.match(prerequisites, /libwebkit2gtk-4\.0-dev/);
  assert.match(prerequisites, /libgtk-3-dev/);
  assert.match(prerequisites, /libayatana-appindicator3-dev/);
});

test('quality job copies the browser frontend before Rust checks', () => {
  const workflow = readWorkflow();
  const quality = jobBlocks(workflow).find(({ name }) => name === 'quality');
  assert.ok(quality, 'quality job is required');
  const browserIndex = quality.text.indexOf('yarn browser build');
  const copyIndex = quality.text.indexOf('npm --workspace applications/tauri run copy:frontend');
  const rustIndex = quality.text.indexOf('- name: Check Rust formatting, lint, and tests');
  assert.ok(browserIndex >= 0, 'quality job must build the browser frontend');
  assert.ok(copyIndex > browserIndex, 'quality job must copy the browser frontend after its build');
  assert.ok(rustIndex > copyIndex, 'quality job must copy the browser frontend before Rust checks');
});

test('quality job frees JavaScript build space while preserving Tauri frontend resources', () => {
  const workflow = readWorkflow();
  const quality = jobBlocks(workflow).find(({ name }) => name === 'quality');
  assert.ok(quality, 'quality job is required');
  const copyIndex = quality.text.indexOf('npm --workspace applications/tauri run copy:frontend');
  const cleanupIndex = quality.text.indexOf('- name: Free JavaScript build space');
  const rustIndex = quality.text.indexOf('- name: Install Rust stable toolchain');
  assert.ok(copyIndex >= 0, 'quality job must copy the browser frontend before cleanup');
  assert.ok(cleanupIndex > copyIndex, 'quality job must clean JavaScript artifacts after the frontend copy');
  assert.ok(rustIndex > cleanupIndex, 'quality job must clean JavaScript artifacts before Rust checks');
  const cleanup = quality.text.slice(cleanupIndex, rustIndex);
  assert.match(cleanup, /rm -rf node_modules/);
  assert.match(cleanup, /rm -rf ["']?\$HOME\/\.cache\/yarn/);
  assert.match(cleanup, /test -f applications\/tauri\/browser-frontend\/index\.html/);
  assert.match(cleanup, /test -f applications\/tauri\/tauri-frontend\/index\.html/);
});

test('product extension compiler supports the locked d3 type declarations', () => {
  const packageFile = path.join(repositoryRoot, 'app', 'theia-extensions', 'product', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const typescript = packageJson.devDependencies?.typescript;
  assert.match(
    typescript ?? '',
    /(?:^|[~^>=])5(?:\.\d+)*(?:$|\s)/,
    `${packageFile} must use TypeScript 5.x for the locked @types/d3-dispatch declarations`,
  );
});

test('product extension scripts resolve TypeScript through the workspace executable path', () => {
  const packageFile = path.join(repositoryRoot, 'app', 'theia-extensions', 'product', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'));

  for (const scriptName of ['build', 'test']) {
    const script = packageJson.scripts?.[scriptName] ?? '';
    assert.doesNotMatch(
      script,
      /node\s+\.\/node_modules\/typescript\/bin\/tsc/,
      `${packageFile} ${scriptName} must not assume dependencies are installed inside the package`,
    );
    assert.match(
      script,
      /(?:^|&&\s*)tsc(?:\s|$)/,
      `${packageFile} ${scriptName} must resolve tsc through the workspace script PATH`,
    );
  }
});
