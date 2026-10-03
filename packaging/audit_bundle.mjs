import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveInstalledManifest } from '../app/scripts/tauri-frontend-profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = path.join(root, 'app/applications/browser');
const require = createRequire(path.join(root, 'app/package.json'));
const semver = require('semver');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const packages = new Map();
const manifests = [];
let positiveInputs = 0;
const virtualInputs = [];
const attestation = JSON.parse(fs.readFileSync(path.join(browser, 'lib/ride-tauri-profile.json'), 'utf8'));

for (const name of fs.readdirSync(path.join(browser, 'lib/metadata')).filter(name => name.endsWith('.json')).sort()) {
  const file = path.join(browser, 'lib/metadata', name);
  const bytes = fs.readFileSync(file);
  const metadata = JSON.parse(bytes);
  if (metadata.buildId !== attestation.buildId || metadata.digest !== attestation.digest) throw new Error(`Mixed build metadata: ${name}`);
  const build = path.join(browser, '.ride-tauri-profile/builds', metadata.buildId);
  if (!metadata.metafile?.outputs || !metadata.outputHashes) throw new Error(`Missing attested metadata: ${name}`);
  for (const [output, expectedHash] of Object.entries(metadata.outputHashes)) {
    const outputFile = path.resolve(browser, output);
    if (!outputFile.startsWith(browser + path.sep) || hash(fs.readFileSync(outputFile)) !== expectedHash) {
      throw new Error(`Stale or escaped output: ${output}`);
    }
  }
  manifests.push({ file: name, sha256: hash(bytes), buildId: metadata.buildId, digest: metadata.digest });
  for (const [output, info] of Object.entries(metadata.metafile.outputs)) {
    for (const [input, contribution] of Object.entries(info.inputs ?? {})) {
      if (!(contribution.bytesInOutput > 0)) continue;
      positiveInputs++;
      if (/^[a-z][a-z\d-]*:/i.test(input)) {
        virtualInputs.push({ input, output, bytesInOutput: contribution.bytesInOutput });
        continue;
      }
      if (!input.replaceAll('\\', '/').includes('node_modules/')) continue;
      let logicalFile = path.resolve(build, input);
      if (!fs.existsSync(logicalFile) && input.startsWith('node_modules/')) {
        // Successful publish removes the generated build and its extension
        // junctions. Recover only a declared, unique extension junction using
        // the same installed-manifest resolver used by profile generation.
        const segments = input.slice('node_modules/'.length).split('/');
        const requestName = segments[0].startsWith('@') ? segments.splice(0, 2).join('/') : segments.shift();
        if (!attestation.extensions.includes(requestName)) throw new Error(`Unknown removed build junction: ${input}`);
        let installed = await resolveInstalledManifest(requestName, browser);
        while (segments[0] === 'node_modules') {
          segments.shift();
          const nestedName = segments[0].startsWith('@') ? segments.splice(0, 2).join('/') : segments.shift();
          installed = await resolveInstalledManifest(nestedName, installed.packageDirectory);
        }
        logicalFile = path.join(installed.packageDirectory, ...segments);
      }
      if (!fs.existsSync(logicalFile)) throw new Error(`Unable to resolve actual contributed input: ${input}`);
      // Walk the actual resolved package rather than guessing a version from a lockfile.
      let directory = path.dirname(fs.realpathSync(logicalFile));
      let manifest;
      while (directory.startsWith(root + path.sep)) {
        const candidate = path.join(directory, 'package.json');
        if (fs.existsSync(candidate)) {
          const value = JSON.parse(fs.readFileSync(candidate, 'utf8'));
          if (value.name && value.version) { manifest = { directory, value }; break; }
        }
        directory = path.dirname(directory);
      }
      if (!manifest) throw new Error(`Input has no attributable package: ${input}`);
      const { value } = manifest;
      const declaredIdentities = attestation.packages.filter(item => item.packageName === value.name);
      if (declaredIdentities.length && !declaredIdentities.some(item => item.version === value.version)) {
        throw new Error(`Installed input identity differs from build attestation: ${value.name}@${value.version}`);
      }
      const key = value.name + '@' + value.version;
      if (!packages.has(key)) packages.set(key, { name: value.name, version: value.version,
        private: value.private === true, identityInDeclaredGraph: declaredIdentities.length > 0,
        packageJsonSha256: hash(fs.readFileSync(path.join(manifest.directory, 'package.json'))),
        inputs: new Map() });
      packages.get(key).inputs.set(input, { file: input, sha256: hash(fs.readFileSync(logicalFile)), output, bytesInOutput: contribution.bytesInOutput });
    }
  }
}
const inventory = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  .map(item => ({ ...item, inputs: [...item.inputs.values()].sort((a, b) => a.file.localeCompare(b.file)) }));
const request = {};
for (const item of inventory) if (!item.private) (request[item.name] ??= []).push(item.version);
for (const key in request) request[key] = [...new Set(request[key])].sort();
const endpoint = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(request), signal: AbortSignal.timeout(60000) });
if (!response.ok) throw new Error(`npm Bulk Advisory API failed: HTTP ${response.status}`);
const raw = await response.text();
const advisories = JSON.parse(raw);
const findings = [];
for (const item of inventory) {
  if (item.private) continue;
  for (const advisory of advisories[item.name] ?? []) {
    if (!semver.satisfies(item.version, advisory.vulnerable_versions, { includePrerelease: true })) continue;
    findings.push({ name: item.name, version: item.version, id: advisory.id, title: advisory.title,
      severity: advisory.severity, vulnerableVersions: advisory.vulnerable_versions, url: advisory.url,
      actualInputCount: item.inputs.length });
  }
}
const report = { schema: 'ride.bundle-audit@1', auditedAt: new Date().toISOString(), endpoint,
  scope: 'Positive esbuild bytesInOutput only; excludes separately copied plugin/runtime dependencies and private local source',
  positiveInputs, virtualInputs, metadata: manifests, packages: inventory, findings,
  privateLocalPackages: inventory.filter(item => item.private).map(({ name, version, packageJsonSha256, inputs }) => ({ name, version, packageJsonSha256, inputs })),
  advisoryResponseSha256: hash(raw) };
fs.writeFileSync(path.join(root, 'artifacts/bundle-audit-response.json'), raw + '\n');
fs.writeFileSync(path.join(root, 'artifacts/bundle-audit.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ packages: inventory.length, privateLocalPackages: report.privateLocalPackages.map(item => item.name),
  findings: findings.length, highCritical: findings.filter(item => ['high', 'critical'].includes(item.severity)).length }, null, 2));
for (const finding of findings) console.log(JSON.stringify(finding));
if (findings.some(item => ['high', 'critical'].includes(item.severity))) process.exitCode = 1;
