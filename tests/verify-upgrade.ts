import { ZipArchive } from 'archiver';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';

async function createZipFromMap(files: Record<string, string | Buffer>): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = new ZipArchive({ zlib: { level: 0 } });
    archive.on('data', (d: Buffer) => chunks.push(d));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, content] of Object.entries(files)) {
      archive.append(content, { name });
    }
    void archive.finalize();
  });
}

async function createStreamingBenchmarkZipFile(sizeMb: number, outPath: string): Promise<number> {
  const payloadPath = `${outPath}.payload.bin`;
  const oneMb = Buffer.alloc(1024 * 1024, 97);
  const fh = await fsp.open(payloadPath, 'w');
  try {
    for (let i = 0; i < sizeMb; i++) {
      await fh.write(oneMb);
    }
  } finally {
    await fh.close();
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(outPath);
      const archive = new ZipArchive({ zlib: { level: 0 } });
      out.on('close', resolve);
      out.on('error', reject);
      archive.on('error', reject);
      archive.pipe(out);
      archive.append(`<h1>Benchmark ${sizeMb} MB</h1>`, { name: 'index.html' });
      archive.file(payloadPath, { name: 'payload.bin' });
      void archive.finalize();
    });
  } finally {
    await fsp.rm(payloadPath, { force: true }).catch(() => {});
  }

  const stat = await fsp.stat(outPath);
  return stat.size;
}

async function benchmarkUploadFromFile(
  token: string,
  filename: string,
  filePath: string,
  totalSize: number,
  chunkSize: number,
  concurrency: number
): Promise<{ totalMs: number; mbPerSec: number; projectId: string; slug: string }> {
  const startedAt = performance.now();
  const initRes = await fetch(`${BASE_URL}/api/uploads/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token },
    body: JSON.stringify({ filename, totalSize, chunkSize }),
  });
  const initData = await initRes.json();
  if (!initRes.ok) throw new Error(`Init failed: ${initData.error}`);
  const session = initData.session as { id: string; chunk_size: number; total_chunks: number };

  const fh = await fsp.open(filePath, 'r');
  try {
    let cursor = 0;
    const worker = async () => {
      const readBuf = Buffer.allocUnsafe(session.chunk_size);
      while (true) {
        const idx = cursor++;
        if (idx >= session.total_chunks) return;
        const start = idx * session.chunk_size;
        const len = Math.min(session.chunk_size, totalSize - start);
        await fh.read(readBuf, 0, len, start);
        const res = await fetch(`${BASE_URL}/api/uploads/${session.id}/chunk/${idx}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Workspace-Token': token,
          },
          body: new Uint8Array(readBuf.subarray(0, len)),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(`Chunk ${idx} failed: ${err.error || res.status}`);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, session.total_chunks) }, () => worker())
    );
  } finally {
    await fh.close();
  }

  const compRes = await fetch(`${BASE_URL}/api/uploads/${session.id}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token },
    body: '{}',
  });
  const compData = await compRes.json();
  if (!compRes.ok) throw new Error(`Complete failed: ${compData.error}`);

  const totalMs = performance.now() - startedAt;
  const mb = totalSize / (1024 * 1024);
  const mbPerSec = mb / (totalMs / 1000);
  const project = compData.project as { id: string; slug: string };

  // Give background pipeline a moment to enter safely and then delete cleanly
  await new Promise((r) => setTimeout(r, 250));
  await fetch(`${BASE_URL}/api/projects/${project.id}`, {
    method: 'DELETE',
    headers: { 'X-Workspace-Token': token },
  });

  return { totalMs, mbPerSec, projectId: project.id, slug: project.slug };
}

async function uploadBufferAndBuild(
  token: string,
  filename: string,
  buf: Buffer,
  chunkSize = 4 * 1024 * 1024,
  concurrency = 4
) {
  const initRes = await fetch(`${BASE_URL}/api/uploads/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token },
    body: JSON.stringify({ filename, totalSize: buf.length, chunkSize }),
  });
  const initData = await initRes.json();
  if (!initRes.ok) throw new Error(`Init failed: ${initData.error}`);
  const session = initData.session as { id: string; chunk_size: number; total_chunks: number };

  let cursor = 0;
  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= session.total_chunks) return;
      const start = idx * session.chunk_size;
      const end = Math.min(buf.length, start + session.chunk_size);
      const res = await fetch(`${BASE_URL}/api/uploads/${session.id}/chunk/${idx}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Workspace-Token': token,
        },
        body: new Uint8Array(buf.subarray(start, end)),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`Chunk ${idx} failed: ${err.error || res.status}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, session.total_chunks) }, () => worker()));

  const compRes = await fetch(`${BASE_URL}/api/uploads/${session.id}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token },
    body: '{}',
  });
  const compData = await compRes.json();
  if (!compRes.ok) throw new Error(`Complete failed: ${compData.error}`);
  return compData.project as { id: string; slug: string };
}

async function waitForBuild(token: string, projectId: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/api/projects/${projectId}`, {
      headers: { 'X-Workspace-Token': token },
    });
    const data = await res.json();
    const p = data.project as {
      id: string;
      slug: string;
      status: string;
      framework: string;
      install_cmd: string | null;
      build_cmd: string | null;
      start_cmd: string | null;
      error_message: string | null;
      live_url: string | null;
      build_duration_ms: number | null;
    };
    if (p.status === 'live' || p.status === 'public_blocked' || p.status === 'failed') {
      return { project: p, logs: data.logs as Array<{ stage: string; level: string; message: string }> };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for project ${projectId}`);
}

function isBuiltOk(status: string, publicHostingReady: boolean): boolean {
  return publicHostingReady ? status === 'live' : status === 'public_blocked';
}

async function run() {
  const sessRes = await fetch(`${BASE_URL}/api/session`);
  const sess = await sessRes.json();
  const token = sess.workspaceToken as string;
  const publicHostingReady = Boolean(sess.capabilities?.publicHostingReady);

  console.log('=== PART 1: STREAMING UPLOAD SPEED BENCHMARK (BEFORE 1x2MB vs AFTER 6x6MB PARALLEL) ===');
  for (const sizeMb of [5, 50, 100, 500]) {
    const zipPath = path.join(os.tmpdir(), `waqas-bench-${sizeMb}mb.zip`);
    try {
      const totalSize = await createStreamingBenchmarkZipFile(sizeMb, zipPath);
      if (sizeMb <= 100) {
        const before = await benchmarkUploadFromFile(
          token,
          `bench-${sizeMb}mb-before.zip`,
          zipPath,
          totalSize,
          2 * 1024 * 1024,
          1
        );
        const after = await benchmarkUploadFromFile(
          token,
          `bench-${sizeMb}mb-after.zip`,
          zipPath,
          totalSize,
          6 * 1024 * 1024,
          6
        );
        const speedup = (after.mbPerSec / before.mbPerSec).toFixed(2);
        console.log(
          `  ${sizeMb} MB ZIP: BEFORE (1x2MB)=${before.totalMs.toFixed(0)}ms (${before.mbPerSec.toFixed(1)} MB/s) | AFTER (6x6MB)=${after.totalMs.toFixed(0)}ms (${after.mbPerSec.toFixed(1)} MB/s) -> ${speedup}x`
        );
      } else {
        const after500 = await benchmarkUploadFromFile(
          token,
          `bench-${sizeMb}mb-after.zip`,
          zipPath,
          totalSize,
          8 * 1024 * 1024,
          6
        );
        console.log(
          `  ${sizeMb} MB ZIP: AFTER (6x8MB)=${after500.totalMs.toFixed(0)}ms (${after500.mbPerSec.toFixed(1)} MB/s)`
        );
      }
    } finally {
      await fsp.rm(zipPath, { force: true }).catch(() => {});
    }
  }

  console.log('\n=== PART 2: AUTOMATIC BUILD & RECOVERY TESTS ===');

  // Test A: ERESOLVE peer-dependency conflict recovery (esbuild@^0.25.0 + vite@^8.3.0)
  console.log('A. Testing npm ERESOLVE peer conflict auto-recovery (esbuild@^0.25.0 + vite@^8.3.0)...');
  const eresolveZip = await createZipFromMap({
    'eresolve-app/package.json': JSON.stringify({
      name: 'eresolve-app',
      private: true,
      type: 'module',
      scripts: { build: 'vite build' },
      dependencies: { react: '^19.0.1', 'react-dom': '^19.0.1', '@vitejs/plugin-react': '^6.1.1', vite: '^8.3.0' },
      devDependencies: { esbuild: '^0.25.0' },
    }),
    'eresolve-app/vite.config.js':
      'import { defineConfig } from "vite"; import react from "@vitejs/plugin-react"; export default defineConfig({ plugins: [react()] });',
    'eresolve-app/index.html':
      '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
    'eresolve-app/src/main.jsx':
      'import React from "react"; import { createRoot } from "react-dom/client"; createRoot(document.getElementById("root")).render(React.createElement("h1", null, "ERESOLVE Recovered"));',
  });
  const projA = await uploadBufferAndBuild(token, 'eresolve-app.zip', eresolveZip);
  const resA = await waitForBuild(token, projA.id);
  if (!isBuiltOk(resA.project.status, publicHostingReady)) {
    throw new Error(
      `ERESOLVE recovery failed: status=${resA.project.status} ${resA.project.error_message}\nLogs: ${JSON.stringify(resA.logs.slice(-15))}`
    );
  }
  const bodyA = await (await fetch(`${BASE_URL}/sites/${resA.project.slug}/`)).text();
  if (!bodyA.includes('assets/')) throw new Error('Built Vite HTML missing assets');
  console.log(
    `   PASS: ERESOLVE auto-recovered (${resA.project.status}) at /sites/${resA.project.slug}/ (${(resA.project.build_duration_ms! / 1000).toFixed(1)}s)`
  );
  await fetch(`${BASE_URL}/api/projects/${projA.id}`, {
    method: 'DELETE',
    headers: { 'X-Workspace-Token': token },
  });

  // Test B: Full-stack Express + Vite + bun.lock + ERESOLVE recovery
  console.log('B. Testing bun.lock + Full-stack Express + Vite app...');
  const bunFullstackZip = await createZipFromMap({
    'fullstack-bun/package.json': JSON.stringify({
      name: 'fullstack-bun',
      private: true,
      type: 'module',
      scripts: {
        build: 'vite build',
        'start:prod': 'node server.js',
      },
      dependencies: {
        express: '^4.21.2',
        react: '^19.0.1',
        'react-dom': '^19.0.1',
        '@vitejs/plugin-react': '^6.1.1',
        vite: '^8.3.0',
      },
      devDependencies: { esbuild: '^0.25.0' },
    }),
    'fullstack-bun/bun.lock': '{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "fullstack-bun" } },\n  "packages": {}\n}\n',
    'fullstack-bun/vite.config.js':
      'import { defineConfig } from "vite"; import react from "@vitejs/plugin-react"; export default defineConfig({ base: "./", plugins: [react()] });',
    'fullstack-bun/index.html':
      '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
    'fullstack-bun/src/main.jsx':
      'import React from "react"; import { createRoot } from "react-dom/client"; createRoot(document.getElementById("root")).render(React.createElement("h1", null, "Fullstack Bun OK"));',
    'fullstack-bun/server.js':
      'import express from "express"; import path from "node:path"; const app = express(); app.use(express.static("dist")); app.get("/api/ping", (_req, res) => res.json({ ok: true })); app.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready"));',
  });
  const projB = await uploadBufferAndBuild(token, 'fullstack-bun.zip', bunFullstackZip);
  const resB = await waitForBuild(token, projB.id);
  if (!isBuiltOk(resB.project.status, publicHostingReady) || resB.project.framework !== 'nodejs') {
    throw new Error(
      `Bun fullstack test failed: status=${resB.project.status} fw=${resB.project.framework} err=${resB.project.error_message}\nLogs: ${JSON.stringify(resB.logs.slice(-12))}`
    );
  }
  const pingB = await (await fetch(`${BASE_URL}/sites/${resB.project.slug}/api/ping`)).json();
  if (!pingB.ok) throw new Error('Fullstack API ping failed');
  console.log(
    `   PASS: Full-stack Express+Vite (bun.lock) built (${resB.project.status}) at /sites/${resB.project.slug}/ (${(resB.project.build_duration_ms! / 1000).toFixed(1)}s)`
  );
  await fetch(`${BASE_URL}/api/projects/${projB.id}`, {
    method: 'DELETE',
    headers: { 'X-Workspace-Token': token },
  });

  // Test C: Yarn lockfile project
  console.log('C. Testing Yarn package manager detection & build...');
  const yarnZip = await createZipFromMap({
    'yarn-site/package.json': JSON.stringify({
      name: 'yarn-site',
      private: true,
      scripts: { start: 'node server.js' },
      dependencies: { ms: '^2.1.3' },
    }),
    'yarn-site/yarn.lock':
      '# THIS IS AN AUTOGENERATED YARN LOCKFILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\nms@^2.1.3:\n  version "2.1.3"\n  resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz#574c8138ce1d2b5861f0b44579dbadd60c6615b2"\n  integrity sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==\n',
    'yarn-site/server.js':
      'const http = require("http"); const ms = require("ms"); http.createServer((req, res) => { res.end("Yarn OK " + ms("2 days")); }).listen(process.env.PORT, "127.0.0.1");',
  });
  const projC = await uploadBufferAndBuild(token, 'yarn-site.zip', yarnZip);
  const resC = await waitForBuild(token, projC.id);
  if (!isBuiltOk(resC.project.status, publicHostingReady) || !resC.project.install_cmd?.startsWith('yarn')) {
    throw new Error(`Yarn test failed: ${JSON.stringify(resC.project)}`);
  }
  const yarnBody = await (await fetch(`${BASE_URL}/sites/${resC.project.slug}/`)).text();
  if (!yarnBody.includes('Yarn OK')) throw new Error(`Unexpected Yarn body: ${yarnBody}`);
  console.log(`   PASS: Yarn project built (${resC.project.status}) at /sites/${resC.project.slug}/ (${yarnBody})`);
  await fetch(`${BASE_URL}/api/projects/${projC.id}`, {
    method: 'DELETE',
    headers: { 'X-Workspace-Token': token },
  });

  // Test D: Verify real root cause error extraction on unfixable missing package
  console.log('D. Testing First-Root-Cause Error Extraction (missing 404 package)...');
  const badPkgZip = await createZipFromMap({
    'bad-pkg/package.json': JSON.stringify({
      name: 'bad-pkg',
      private: true,
      scripts: { start: 'node index.js' },
      dependencies: { '@waqas-nonexistent-scope/this-pkg-does-not-exist-99999': '1.0.0' },
    }),
    'bad-pkg/index.js': 'console.log("hi");',
  });
  const projD = await uploadBufferAndBuild(token, 'bad-pkg.zip', badPkgZip);
  const resD = await waitForBuild(token, projD.id);
  console.log(`   Extracted Root Error: ${resD.project.error_message}`);
  if (resD.project.status !== 'failed' || !resD.project.error_message?.includes('404')) {
    throw new Error(`Expected real 404 root error message, got: ${resD.project.error_message}`);
  }
  console.log('   PASS: Exact 404 root cause surfaced instead of generic exit code 1');
  await fetch(`${BASE_URL}/api/projects/${projD.id}`, {
    method: 'DELETE',
    headers: { 'X-Workspace-Token': token },
  });

  // Test E: pnpm-lock.yaml detection & build (graceful fallback when pnpm binary unavailable or direct pnpm)
  console.log('E. Testing pnpm-lock.yaml project detection & build...');
  const pnpmZip = await createZipFromMap({
    'pnpm-site/package.json': JSON.stringify({
      name: 'pnpm-site',
      private: true,
      scripts: { start: 'node server.js' },
      dependencies: { ms: '^2.1.3' },
    }),
    'pnpm-site/pnpm-lock.yaml': 'lockfileVersion: "9.0"\n\nimporters:\n  .:\n    dependencies:\n      ms:\n        specifier: ^2.1.3\n        version: 2.1.3\n',
    'pnpm-site/server.js':
      'const http = require("http"); const ms = require("ms"); http.createServer((req, res) => { res.end("PNPM OK " + ms("1 hour")); }).listen(process.env.PORT, "127.0.0.1");',
  });
  const projE = await uploadBufferAndBuild(token, 'pnpm-site.zip', pnpmZip);
  const resE = await waitForBuild(token, projE.id);
  if (!isBuiltOk(resE.project.status, publicHostingReady)) {
    throw new Error(`pnpm test failed: ${JSON.stringify(resE.project)}`);
  }
  const pnpmBody = await (await fetch(`${BASE_URL}/sites/${resE.project.slug}/`)).text();
  if (!pnpmBody.includes('PNPM OK')) throw new Error(`Unexpected pnpm body: ${pnpmBody}`);
  console.log(`   PASS: pnpm-lock.yaml project built (${resE.project.status}) at /sites/${resE.project.slug}/ (${pnpmBody})`);
  await fetch(`${BASE_URL}/api/projects/${projE.id}`, {
    method: 'DELETE',
    headers: { 'X-Workspace-Token': token },
  });

  // Test F: Pause, resume, and partial failed chunk retry verification
  console.log('F. Testing Pause/Resume & Partial Chunk Upload Recovery...');
  const pausePayload = await createZipFromMap({
    'index.html': '<h1>Pause Resume OK</h1>',
    'blob.bin': Buffer.alloc(4 * 1024 * 1024, 66),
  });
  const initPause = await (
    await fetch(`${BASE_URL}/api/uploads/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token },
      body: JSON.stringify({
        filename: 'pause-resume.zip',
        totalSize: pausePayload.length,
        chunkSize: 1024 * 1024,
      }),
    })
  ).json();
  const s = initPause.session as { id: string; chunk_size: number; total_chunks: number };
  // Upload only chunk 0 and chunk 2 out of order, then pause
  for (const idx of [0, 2]) {
    const start = idx * s.chunk_size;
    const end = Math.min(pausePayload.length, start + s.chunk_size);
    await fetch(`${BASE_URL}/api/uploads/${s.id}/chunk/${idx}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Workspace-Token': token },
      body: new Uint8Array(pausePayload.subarray(start, end)),
    });
  }
  await fetch(`${BASE_URL}/api/uploads/${s.id}/pause`, {
    method: 'POST',
    headers: { 'X-Workspace-Token': token },
  });
  const pausedState = await (
    await fetch(`${BASE_URL}/api/uploads/${s.id}`, { headers: { 'X-Workspace-Token': token } })
  ).json();
  if (pausedState.session.status !== 'paused' || pausedState.session.uploaded_chunks.length !== 2) {
    throw new Error(`Unexpected paused state: ${JSON.stringify(pausedState.session)}`);
  }
  await fetch(`${BASE_URL}/api/uploads/${s.id}/resume`, {
    method: 'POST',
    headers: { 'X-Workspace-Token': token },
  });
  // Upload ONLY missing chunks
  for (let idx = 0; idx < s.total_chunks; idx++) {
    if (pausedState.session.uploaded_chunks.includes(idx)) continue;
    const start = idx * s.chunk_size;
    const end = Math.min(pausePayload.length, start + s.chunk_size);
    await fetch(`${BASE_URL}/api/uploads/${s.id}/chunk/${idx}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Workspace-Token': token },
      body: new Uint8Array(pausePayload.subarray(start, end)),
    });
  }
  const compF = await (
    await fetch(`${BASE_URL}/api/uploads/${s.id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token },
      body: '{}',
    })
  ).json();
  const resF = await waitForBuild(token, compF.project.id);
  if (!isBuiltOk(resF.project.status, publicHostingReady)) {
    throw new Error(`Pause/resume build failed: ${resF.project.error_message}`);
  }
  const bodyF = await (await fetch(`${BASE_URL}/sites/${resF.project.slug}/`)).text();
  if (!bodyF.includes('Pause Resume OK')) throw new Error('Pause/resume site body mismatch');
  console.log(`   PASS: Resumed missing chunks only and built (${resF.project.status}) at /sites/${resF.project.slug}/`);
  await fetch(`${BASE_URL}/api/projects/${compF.project.id}`, {
    method: 'DELETE',
    headers: { 'X-Workspace-Token': token },
  });

  console.log('\nALL UPGRADE BENCHMARK & RECOVERY TESTS PASSED!');
}

run().catch((err) => {
  console.error('\nUPGRADE TEST FAILURE:', err);
  process.exit(1);
});
