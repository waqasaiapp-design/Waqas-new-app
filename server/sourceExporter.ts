import { ZipArchive } from 'archiver';
import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';

const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'data', '.git', '.next', 'coverage']);

export async function streamSourceCodeZip(res: Response): Promise<void> {
  const rootDir = process.cwd();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="waqas-zip-to-web-source.zip"');

  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('error', (err: Error) => {
    if (!res.headersSent) {
      res.status(500).json({ error: `Failed to generate source ZIP: ${err.message}` });
    } else {
      res.end();
    }
  });

  archive.pipe(res);

  function addDirectory(currentDir: string, relBase: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      if (
        entry.name === '.env' ||
        entry.name.endsWith('.sqlite') ||
        entry.name.endsWith('.sqlite-wal') ||
        entry.name.endsWith('.sqlite-shm')
      ) {
        continue;
      }
      const absPath = path.join(currentDir, entry.name);
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        addDirectory(absPath, relPath);
      } else if (entry.isFile()) {
        archive.file(absPath, { name: `waqas-zip-to-web/${relPath}` });
      }
    }
  }

  addDirectory(rootDir, '');
  await archive.finalize();
}
