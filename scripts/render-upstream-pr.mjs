#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const SHA = /^[0-9a-f]{40}$/u;
const MARKER_PR = '<!-- upstream-sync-pr -->';
const MARKER_ISSUE = '<!-- upstream-sync-failure -->';

function usageError(message) { throw new TypeError(message); }

export function parseArgs(argv) {
  const options = { mode: 'pr' };
  const takesValue = new Set(['--report', '--output', '--mode']);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!takesValue.has(flag)) usageError(`unknown flag: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) usageError(`${flag} requires a value`);
    if (flag === '--mode' && value !== 'pr' && value !== 'issue') usageError('--mode must be pr or issue');
    options[flag.slice(2)] = value;
  }
  if (!options.report) usageError('--report is required');
  options.report = path.resolve(options.report);
  if (options.output) options.output = path.resolve(options.output);
  return options;
}

function stringValue(value, fallback = '') { return typeof value === 'string' ? value : fallback; }
function shaValue(value, label) {
  const result = stringValue(value);
  if (!SHA.test(result)) throw new TypeError(`${label} must be a 40-character commit SHA`);
  return result;
}

function reportValues(report) {
  if (!report || typeof report !== 'object') throw new TypeError('report must be an object');
  const previousCommit = shaValue(report.previousCommit, 'previousCommit');
  const targetCommit = shaValue(report.targetCommit, 'targetCommit');
  const counts = report.counts && typeof report.counts === 'object' ? report.counts : {};
  const number = value => Number.isInteger(value) && value >= 0 ? value : 0;
  return {
    previousCommit,
    targetCommit,
    counts: { added: number(counts.added), modified: number(counts.modified), deleted: number(counts.deleted), renamed: number(counts.renamed) },
    ownedPaths: Array.isArray(report.ownedPaths) ? report.ownedPaths.map(String) : [],
    patches: Array.isArray(report.patches) ? report.patches.map(String) : [],
    compareUrl: stringValue(report.compareUrl, '(no compare URL available)'),
    failedStage: stringValue(report.failedStage, 'unknown'),
    stderr: stringValue(report.stderr, '(no stderr captured)'),
    artifactName: stringValue(report.artifactName, 'upstream-sync-diagnostics'),
  };
}

export function renderPullRequest(report) {
  const value = reportValues(report);
  const owned = value.ownedPaths.length ? value.ownedPaths.map(entry => `- ${entry}`).join('\n') : '- (none)';
  const patches = value.patches.length ? value.patches.map(entry => `- ${entry}`).join('\n') : '- (none)';
  return [
    MARKER_PR,
    '# Upstream synchronization',
    '',
    `- Previous upstream commit: \`${value.previousCommit}\``,
    `- Target upstream commit: \`${value.targetCommit}\``,
    `- Compare: ${value.compareUrl}`,
    '',
    '## Change summary',
    '',
    '| Added | Modified | Deleted | Renamed |',
    '| ---: | ---: | ---: | ---: |',
    `| ${value.counts.added} | ${value.counts.modified} | ${value.counts.deleted} | ${value.counts.renamed} |`,
    '',
    '## Owned paths', '', owned, '',
    '## Patches replayed', '', patches, '',
    '## Required checks', '',
    '- CI / Quality',
    '- CI / Upstream compatibility',
    '- CI / Package (all desktop matrix entries)',
    '',
    'Automatic merging is intentionally disabled; review and merge this pull request manually.',
    '',
  ].join('\n');
}

export function renderIssue(report) {
  const value = reportValues(report);
  return [
    MARKER_ISSUE,
    '# Upstream synchronization failed', '',
    `- Failed stage: \`${value.failedStage}\``,
    `- Upstream target: \`${value.targetCommit}\``,
    `- Diagnostics artifact: \`${value.artifactName}\``, '',
    '## Error summary', '',
    '```', value.stderr.slice(0, 8000), '```', '',
    '## Reproduction', '',
    'Run the following command from a clean checkout:', '',
    '```sh',
    `node scripts/sync-upstream.mjs sync --target ${value.targetCommit} --report upstream-sync-report.json`,
    '```', '',
  ].join('\n');
}

export async function render({ report, mode = 'pr' }) {
  const parsed = JSON.parse(await fs.readFile(report, 'utf8'));
  return mode === 'issue' ? renderIssue(parsed) : renderPullRequest(parsed);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const output = await render(options);
  if (options.output) {
    await fs.mkdir(path.dirname(options.output), { recursive: true });
    await fs.writeFile(options.output, output, 'utf8');
  } else process.stdout.write(output);
}

if (process.argv[1]?.endsWith('render-upstream-pr.mjs')) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

export { MARKER_ISSUE, MARKER_PR };
