import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function assertWithin(root, candidate) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Esbuild output escapes browser build directory: ${candidate}`);
    }
}

function writeFileAtomic(file, content) {
    const unique = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const temporary = `${file}.tmp-${unique}`;
    const backup = `${file}.backup-${unique}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, content, { flag: 'wx' });
    let backedUp = false;
    try {
        if (fs.existsSync(file)) {
            fs.renameSync(file, backup);
            backedUp = true;
        }
        try {
            fs.renameSync(temporary, file);
        } catch (error) {
            if (backedUp) {
                fs.renameSync(backup, file);
                backedUp = false;
            }
            throw error;
        }
        if (backedUp) {
            fs.rmSync(backup, { force: false });
        }
    } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
    }
}

function outputHashes(baseDirectory, metafile) {
    return Object.fromEntries(Object.keys(metafile.outputs).sort().map(output => {
        const outputPath = path.resolve(baseDirectory, output);
        assertWithin(baseDirectory, outputPath);
        const stat = fs.lstatSync(outputPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(`Esbuild output is not a regular file: ${output}`);
        }
        const hash = crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex');
        return [output, hash];
    }));
}

export function createProfileMetadataPlugin({ target, profileManifest, baseDirectory }) {
    const metadataFile = path.join(baseDirectory, 'lib', 'metadata', `${target}.json`);
    return {
        name: `ride-tauri-metadata-${target}`,
        setup(build) {
            build.onEnd(result => {
                if (result.errors.length > 0 || !result.metafile) {
                    fs.rmSync(metadataFile, { force: true });
                    return;
                }
                try {
                    const record = {
                        schema: 'ride.esbuild-metafile@1',
                        profile: profileManifest.profile,
                        buildId: profileManifest.buildId,
                        digest: profileManifest.digest,
                        target,
                        outputHashes: outputHashes(baseDirectory, result.metafile),
                        metafile: result.metafile,
                    };
                    writeFileAtomic(metadataFile, `${JSON.stringify(record, null, 2)}\n`);
                } catch (error) {
                    fs.rmSync(metadataFile, { force: true });
                    throw error;
                }
            });
        },
    };
}
