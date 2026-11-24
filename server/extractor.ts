import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import { probeHostCapabilities } from './config.ts';
import { resolveSafePath } from './security.ts';

export interface ExtractResult {
  projectRootDir: string;
  rootSubpath: string;
  fileCount: number;
  extractedBytes: number;
}

const SKIP_WRAPPER_DIRS = new Set(['__MACOSX', '.git', '.svn', '.DS_Store']);

/**
 * Streams ZIP entries safely to disk with ZIP bomb, symlink, and path traversal defenses.
 */
export async function extractZipSecurely(
  zipPath: string,
  destDir: string,
  onProgress?: (msg: string) => void
): Promise<ExtractResult> {
  const caps = await probeHostCapabilities();
  const maxBytes = caps.maxExtractBytes;
  const maxFiles = caps.maxExtractFiles;

  await fsp.rm(destDir, { recursive: true, force: true });
  await fsp.mkdir(destDir, { recursive: true });

  let fileCount = 0;
  let extractedBytes = 0;

  await new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        return reject(new Error(`Invalid or corrupted ZIP archive: ${openErr?.message || 'unable to open'}`));
      }

      let failed = false;
      const fail = (err: Error) => {
        if (failed) return;
        failed = true;
        try {
          zipfile.close();
        } catch {
          // ignore
        }
        reject(err);
      };

      zipfile.on('error', (err) => fail(new Error(`ZIP read error: ${err.message}`)));
      zipfile.on('end', () => {
        if (!failed) resolve();
      });

      zipfile.on('entry', async (entry: yauzl.Entry) => {
        if (failed) return;
        try {
          const rawName = entry.fileName.replace(/\\/g, '/');

          // Ignore macOS metadata forks safely
          if (rawName.startsWith('__MACOSX/') || rawName.endsWith('/.DS_Store') || rawName === '.DS_Store') {
            zipfile.readEntry();
            return;
          }

          // Block symlinks (POSIX mode 0120000 in upper 16 bits of externalFileAttributes)
          const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (unixMode === 0o120000) {
            return fail(new Error(`Security policy rejected symlink inside ZIP: ${rawName}`));
          }

          // Path traversal check
          const targetPath = resolveSafePath(destDir, rawName);

          if (rawName.endsWith('/')) {
            await fsp.mkdir(targetPath, { recursive: true });
            zipfile.readEntry();
            return;
          }

          fileCount += 1;
          if (fileCount > maxFiles) {
            return fail(
              new Error(`ZIP archive exceeds maximum allowed file count (${maxFiles} files).`)
            );
          }

          // ZIP bomb / ratio guard
          if (
            entry.uncompressedSize > 1024 * 1024 &&
            entry.compressedSize > 0 &&
            entry.uncompressedSize / entry.compressedSize > 120
          ) {
            return fail(
              new Error(
                `Security policy rejected suspicious compression ratio in ${rawName} (possible ZIP bomb).`
              )
            );
          }

          if (extractedBytes + entry.uncompressedSize > maxBytes) {
            const maxMb = (maxBytes / (1024 * 1024)).toFixed(0);
            return fail(
              new Error(`Uncompressed archive size exceeds host safety limit (${maxMb} MB).`)
            );
          }

          await fsp.mkdir(path.dirname(targetPath), { recursive: true });

          zipfile.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr || !readStream) {
              return fail(new Error(`Failed reading ZIP entry ${rawName}: ${streamErr?.message}`));
            }

            let entryActualBytes = 0;
            const writeStream = fs.createWriteStream(targetPath, { flags: 'w' });

            readStream.on('data', (chunk: Buffer) => {
              entryActualBytes += chunk.length;
              extractedBytes += chunk.length;
              if (extractedBytes > maxBytes) {
                readStream.destroy();
                writeStream.destroy();
                fail(new Error('Uncompressed stream exceeded extraction size limit (ZIP bomb protection).'));
              }
            });

            readStream.on('error', (err) => {
              writeStream.destroy();
              fail(new Error(`Stream error on ${rawName}: ${err.message}`));
            });

            writeStream.on('error', (err) => {
              readStream.destroy();
              fail(new Error(`Disk write error on ${rawName}: ${err.message}`));
            });

            writeStream.on('finish', () => {
              if (!failed) {
                if (fileCount % 250 === 0 && onProgress) {
                  onProgress(`Extracted ${fileCount} files (${(extractedBytes / (1024 * 1024)).toFixed(1)} MB)...`);
                }
                zipfile.readEntry();
              }
            });

            readStream.pipe(writeStream);
          });
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      });

      zipfile.readEntry();
    });
  });

  if (fileCount === 0) {
    throw new Error('The ZIP archive contains no files.');
  }

  const { rootDir, subpath } = await locateProjectRoot(destDir);
  return {
    projectRootDir: rootDir,
    rootSubpath: subpath,
    fileCount,
    extractedBytes,
  };
}

const ROOT_MARKERS = new Set([
  'package.json',
  'dockerfile',
  'index.html',
  'requirements.txt',
  'pyproject.toml',
  'app.py',
  'main.py',
  'server.py',
  'manage.py',
]);

/**
 * Unwraps nested single-directory ZIP wrappers (e.g. `my-app-main/my-app/package.json`).
 */
async function locateProjectRoot(baseDir: string): Promise<{ rootDir: string; subpath: string }> {
  let current = baseDir;
  const segments: string[] = [];

  for (let depth = 0; depth < 4; depth++) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    const visible = entries.filter((e) => !SKIP_WRAPPER_DIRS.has(e.name) && !e.name.startsWith('.'));

    const hasMarker = visible.some(
      (e) => e.isFile() && ROOT_MARKERS.has(e.name.toLowerCase())
    );
    if (hasMarker) {
      return { rootDir: current, subpath: segments.join('/') };
    }

    const dirs = visible.filter((e) => e.isDirectory());
    const files = visible.filter((e) => e.isFile());

    // Unwrap if there is exactly 1 visible directory and no project files at this level
    if (dirs.length === 1 && files.length === 0) {
      segments.push(dirs[0].name);
      current = path.join(current, dirs[0].name);
      continue;
    }

    // Otherwise check immediate subdirectories for a marker
    for (const dir of dirs) {
      const subPath = path.join(current, dir.name);
      const subEntries = await fsp.readdir(subPath, { withFileTypes: true });
      if (subEntries.some((e) => e.isFile() && ROOT_MARKERS.has(e.name.toLowerCase()))) {
        segments.push(dir.name);
        return { rootDir: subPath, subpath: segments.join('/') };
      }
    }
    break;
  }

  return { rootDir: current, subpath: segments.join('/') };
}
