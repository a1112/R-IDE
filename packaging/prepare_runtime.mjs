import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'app/applications/browser/node_modules/scanoss');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
if (manifest.name !== 'scanoss' || manifest.version !== '0.15.7') {
  throw new Error('Reassess the scoped SCANOSS tar compatibility patch for this package version');
}
// SCANOSS 0.15.7 expects the old ESM default export of tar 6. The maintained tar
// 7 exposes namespace exports; match the import used by newer SCANOSS releases.
// Preserve all extraction policy from the patched tar implementation.
const file = path.join(directory, 'build/module/sdk/Decompress/Decompressor/DecompressTgz.js');
const before = "import tar from 'tar';";
const after = "import * as tar from 'tar';";
const source = fs.readFileSync(file, 'utf8');
if (!source.includes(before) && !source.includes(after)) throw new Error('Unexpected SCANOSS tar import; refusing an unchecked patch');
fs.writeFileSync(file, source.replace(before, after));
console.log('Applied SCANOSS 0.15.7 ESM tar namespace compatibility patch');
