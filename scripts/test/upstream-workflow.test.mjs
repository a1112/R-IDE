import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'upstream-sync.yml');
const rendererPath = path.join(repositoryRoot, 'scripts', 'render-upstream-pr.mjs');

function readWorkflow() {
  assert.ok(fs.existsSync(workflowPath), `expected workflow at ${workflowPath}`);
  return fs.readFileSync(workflowPath, 'utf8');
}

function jobBlock(workflow, name) {
  const jobs = workflow.split(/^jobs:\s*$/m)[1];
  assert.ok(jobs, 'workflow must define jobs');
  const match = new RegExp(`^  ${name}:\\s*$`, 'm').exec(jobs);
  assert.ok(match, `expected ${name} job`);
  const next = /^  [A-Za-z0-9_-]+:\s*$/gm;
  next.lastIndex = match.index + match[0].length;
  const following = next.exec(jobs);
  return jobs.slice(match.index, following?.index ?? jobs.length);
}

test('upstream workflow has scheduled and manual target inputs', () => {
  const workflow = readWorkflow();
  assert.match(workflow, /^on:\s*$/m);
  assert.match(workflow, /^\s+schedule:\s*$/m);
  assert.match(workflow, /cron:\s*['"]?[^\n]+/);
  assert.match(workflow, /^\s+workflow_dispatch:\s*$/m);
  assert.match(workflow, /target_commit:/);
  assert.match(workflow, /description:/);
  assert.match(workflow, /required:\s*false/);
  assert.match(workflow, /concurrency:\s*\n\s+group:/m);
});

test('upstream write job uses the narrow write permissions and skips pull requests', () => {
  const workflow = readWorkflow();
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
  const sync = jobBlock(workflow, 'sync');
  assert.match(sync, /if:\s*!?\s*\$\{\{\s*github\.event_name\s*!=\s*['"]pull_request['"]\s*&&\s*github\.repository\s*==\s*github\.event\.repository\.full_name\s*\}\}/);
  assert.match(sync, /permissions:\s*\n\s+contents:\s*write\s*\n\s+pull-requests:\s*write\s*\n\s+issues:\s*write/);
  assert.doesNotMatch(sync, /actions:\s*write|id-token:\s*write|packages:\s*write/);
});

test('sync runs before push, uses bot branch, gh PR commands, and no merge automation', () => {
  const workflow = readWorkflow();
  const sync = jobBlock(workflow, 'sync');
  const cliIndex = sync.indexOf('scripts/sync-upstream.mjs sync');
  const pushIndex = sync.indexOf('git push');
  assert.ok(cliIndex >= 0, 'workflow must invoke the sync CLI');
  assert.ok(pushIndex > cliIndex, 'sync CLI must run before push');
  assert.match(sync, /automation\/upstream-sync/);
  assert.match(sync, /gh\s+pr\s+(?:create|edit)/);
  assert.doesNotMatch(sync, /gh\s+pr\s+merge|auto-merge|enable-automerge|merge --auto/i);
  assert.match(sync, /--force-with-lease/);
  assert.match(sync, /bot-authored|github-actions\[bot\]|upstream-sync-failure/i);
});

test('no-op synchronization cannot publish a branch or pull request', () => {
  const sync = jobBlock(readWorkflow(), 'sync');
  const commitStart = sync.indexOf('Check synchronization scope and commit');
  const pushStart = sync.indexOf('Push bot synchronization branch');
  assert.ok(commitStart >= 0 && pushStart > commitStart);
  const commit = sync.slice(commitStart, pushStart);
  assert.match(commit, /changed=false/);
  assert.match(commit, /GITHUB_OUTPUT/);
  assert.doesNotMatch(commit, /process\.exit\(0\)[\s\S]*echo[ \t]+["']?changed=true/);
  const push = sync.slice(pushStart);
  assert.match(push, /if:\s*steps\.commit\.outputs\.changed\s*==\s*['"]true['"]/);
  assert.match(push, /gh\s+pr\s+(?:create|edit)/);
});

test('failure diagnostics are uploaded and failures use a marker issue', () => {
  const workflow = readWorkflow();
  const sync = jobBlock(workflow, 'sync');
  assert.match(sync, /if:\s*\$\{\{\s*failure\(\)\s*\}\}/);
  assert.match(sync, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(sync, /upstream-sync-diagnostics/);
  assert.match(sync, /gh\s+issue\s+(?:create|edit|list)/);
  assert.match(sync, /UPSTREAM_SYNC_FAILURE_MARKER/);
  assert.match(sync, /close|closed/);
});

test('all workflow actions are pinned to approved full commit SHAs', () => {
  const workflow = readWorkflow();
  const uses = [...workflow.matchAll(/^\s+uses:\s*([^\s#]+)\s*$/gm)].map(match => match[1]);
  assert.ok(uses.length > 0);
  const allowed = new Set([
    'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
    'actions/setup-node@6044e13b5dc448c55e2357c09f80417699197238',
    'actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f',
  ]);
  for (const action of uses) {
    assert.ok(allowed.has(action), `unexpected action ${action}`);
    assert.match(action, /@[0-9a-f]{40}$/);
  }
});

const report = {
  changed: true,
  previousCommit: '1111111111111111111111111111111111111111',
  targetCommit: '2222222222222222222222222222222222222222',
  counts: { added: 2, modified: 3, deleted: 1, renamed: 1 },
  ownedPaths: ['applications/tauri/', 'README.md'],
  patches: ['0001-workspace.patch'],
  compareUrl: 'https://github.com/eclipse-theia/theia-ide/compare/1111111...2222222',
};

test('renderer emits stable PR snapshot and policy sections', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'upstream-render-'));
  const reportFile = path.join(dir, 'report.json');
  const outputFile = path.join(dir, 'pr.md');
  await fs.promises.writeFile(reportFile, `${JSON.stringify(report)}\n`);
  await execFileAsync(process.execPath, [rendererPath, '--report', reportFile, '--output', outputFile, '--mode', 'pr']);
  const output = await fs.promises.readFile(outputFile, 'utf8');
  assert.equal(output, `<!-- upstream-sync-pr -->\n# Upstream synchronization\n\n- Previous upstream commit: \`1111111111111111111111111111111111111111\`\n- Target upstream commit: \`2222222222222222222222222222222222222222\`\n- Compare: https://github.com/eclipse-theia/theia-ide/compare/1111111...2222222\n\n## Change summary\n\n| Added | Modified | Deleted | Renamed |\n| ---: | ---: | ---: | ---: |\n| 2 | 3 | 1 | 1 |\n\n## Owned paths\n\n- applications/tauri/\n- README.md\n\n## Patches replayed\n\n- 0001-workspace.patch\n\n## Required checks\n\n- CI / Quality\n- CI / Upstream compatibility\n- CI / Package (all desktop matrix entries)\n\nAutomatic merging is intentionally disabled; review and merge this pull request manually.\n`);
});

test('renderer emits issue diagnostics and exact reproduction command', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'upstream-render-'));
  const reportFile = path.join(dir, 'report.json');
  const outputFile = path.join(dir, 'issue.md');
  await fs.promises.writeFile(reportFile, `${JSON.stringify({ ...report, failedStage: 'patch-preflight', stderr: 'reject at app/file.ts', artifactName: 'upstream-sync-diagnostics' })}\n`);
  await execFileAsync(process.execPath, [rendererPath, '--report', reportFile, '--output', outputFile, '--mode', 'issue']);
  const output = await fs.promises.readFile(outputFile, 'utf8');
  assert.match(output, /^<!-- upstream-sync-failure -->/);
  assert.match(output, /Failed stage: `patch-preflight`/);
  assert.match(output, /reject at app\/file\.ts/);
  assert.match(output, /upstream-sync-diagnostics/);
  assert.match(output, /node scripts\/sync-upstream\.mjs sync --target 2222222222222222222222222222222222222222 --report upstream-sync-report\.json/);
});
