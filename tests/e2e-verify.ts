import { ZipArchive } from 'archiver';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';

async function createZipFromMap(files: Record<string, string | Buffer>): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = new ZipArchive({ zlib: { level: 1 } });
    archive.on('data', (d: Buffer) => chunks.push(d));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, content] of Object.entries(files)) {
      archive.append(content, { name });
    }
    void archive.finalize();
  });
}

async function uploadAndDeployZip(
  token: string,
  filename: string,
  zipBuf: Buffer,
  options: { testPauseResume?: boolean } = {}
): Promise<Record<string, unknown>> {
  const sha256Expected = crypto.createHash('sha256').update(zipBuf).digest('hex');

  const initRes = await fetch(`${BASE_URL}/api/uploads/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Workspace-Token': token,
    },
    body: JSON.stringify({
      filename,
      totalSize: zipBuf.length,
      sha256Expected,
    }),
  });
  const initData = await initRes.json();
  if (!initRes.ok) throw new Error(`Init failed for ${filename}: ${initData.error}`);
  const session = initData.session as {
    id: string;
    chunk_size: number;
    total_chunks: number;
  };

  for (let idx = 0; idx < session.total_chunks; idx++) {
    if (options.testPauseResume && idx === 1) {
      const pauseRes = await fetch(`${BASE_URL}/api/uploads/${session.id}/pause`, {
        method: 'POST',
        headers: { 'X-Workspace-Token': token },
      });
      if (!pauseRes.ok) throw new Error('Pause failed');
      const resumeRes = await fetch(`${BASE_URL}/api/uploads/${session.id}/resume`, {
        method: 'POST',
        headers: { 'X-Workspace-Token': token },
      });
      if (!resumeRes.ok) throw new Error('Resume failed');
    }

    const start = idx * session.chunk_size;
    const end = Math.min(zipBuf.length, start + session.chunk_size);
    const slice = zipBuf.subarray(start, end);
    const chunkSha = crypto.createHash('sha256').update(slice).digest('hex');

    const chunkRes = await fetch(`${BASE_URL}/api/uploads/${session.id}/chunk/${idx}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Workspace-Token': token,
        'X-Chunk-SHA256': chunkSha,
      },
      body: new Uint8Array(slice),
    });
    if (!chunkRes.ok) {
      const err = await chunkRes.json();
      throw new Error(`Chunk ${idx} failed: ${err.error}`);
    }
  }

  const compRes = await fetch(`${BASE_URL}/api/uploads/${session.id}/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Workspace-Token': token,
    },
    body: JSON.stringify({}),
  });
  const compData = await compRes.json();
  if (!compRes.ok) throw new Error(`Complete failed: ${compData.error}`);
  const projectId = compData.project.id as string;

  // Poll until live or failed
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const pRes = await fetch(`${BASE_URL}/api/projects/${projectId}`, {
      headers: { 'X-Workspace-Token': token },
    });
    const pData = await pRes.json();
    const proj = pData.project as Record<string, unknown>;
    if (proj.status === 'live' || proj.status === 'public_blocked' || proj.status === 'failed') {
      return { project: proj, logs: pData.logs };
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`Timed out waiting for build of ${filename}`);
}

function assertDeployedStatus(
  proj: { slug: string; status: string; live_url: string | null; preview_url: string | null },
  publicHostingReady: boolean,
  label: string
) {
  const expectedStatus = publicHostingReady ? 'live' : 'public_blocked';
  if (proj.status !== expectedStatus) {
    throw new Error(`${label} expected status=${expectedStatus}, got ${JSON.stringify(proj)}`);
  }
  if (!publicHostingReady && proj.live_url !== null) {
    throw new Error(`${label} leaked unverified live_url=${proj.live_url} when public hosting is blocked`);
  }
  if (proj.preview_url !== `/sites/${proj.slug}/`) {
    throw new Error(`${label} missing preview_url=/sites/${proj.slug}/: ${JSON.stringify(proj)}`);
  }
}

async function runTests() {
  const sessionRes = await fetch(`${BASE_URL}/api/session`);
  const sessionJson = await sessionRes.json();
  const token = sessionJson.workspaceToken as string;
  const publicHostingReady = Boolean(sessionJson.capabilities?.publicHostingReady);
  const otherToken = crypto.randomBytes(24).toString('hex');

  console.log('1. Testing Basic Nested HTML/CSS/JS Website...');
  const staticZip = await createZipFromMap({
    'nested-portfolio/index.html':
      '<!doctype html><html><head><title>Static Test</title><link rel="stylesheet" href="/style.css"></head><body><h1>Hello From Static ZIP</h1><script src="/app.js"></script></body></html>',
    'nested-portfolio/style.css': 'body { font-family: sans-serif; color: #111; }',
    'nested-portfolio/app.js': 'window.__STATIC_LOADED = true;',
  });
  const staticRes = await uploadAndDeployZip(token, 'static-site.zip', staticZip);
  const staticProj = staticRes.project as {
    id: string;
    slug: string;
    status: string;
    framework: string;
    live_url: string | null;
    preview_url: string | null;
  };
  assertDeployedStatus(staticProj, publicHostingReady, 'Static deploy');
  const staticHtml = await (await fetch(`${BASE_URL}/sites/${staticProj.slug}/`)).text();
  const staticCss = await fetch(`${BASE_URL}/sites/${staticProj.slug}/style.css`);
  if (!staticHtml.includes('Hello From Static ZIP') || staticCss.status !== 200) {
    throw new Error('Static site verification failed');
  }
  console.log(`   PASS: Static HTML/CSS/JS verified (${staticProj.status}, framework=${staticProj.framework})`);

  console.log('2. Testing Real Node.js Web Application...');
  const nodeZip = await createZipFromMap({
    'node-app/package.json': JSON.stringify({
      name: 'test-node-app',
      version: '1.0.0',
      scripts: { start: 'node server.js' },
    }),
    'node-app/server.js': `
      const http = require('http');
      const port = process.env.PORT || 3000;
      const server = http.createServer((req, res) => {
        if (req.url === '/api/ping') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, runtime: 'nodejs' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Node App Live</h1>');
      });
      server.listen(port, '127.0.0.1');
    `,
  });
  const nodeRes = await uploadAndDeployZip(token, 'node-app.zip', nodeZip);
  const nodeProj = nodeRes.project as {
    id: string;
    slug: string;
    status: string;
    framework: string;
    live_url: string | null;
    preview_url: string | null;
  };
  assertDeployedStatus(nodeProj, publicHostingReady, 'Node deploy');
  const nodeHome = await (await fetch(`${BASE_URL}/sites/${nodeProj.slug}/`)).text();
  const nodeApi = await (await fetch(`${BASE_URL}/sites/${nodeProj.slug}/api/ping`)).json();
  if (!nodeHome.includes('Node App Live') || !nodeApi.ok) {
    throw new Error('Node app verification failed');
  }
  console.log(`   PASS: Node.js app verified (${nodeProj.status}, API ok=${nodeApi.ok})`);

  console.log('3. Testing Real Python Web Application...');
  const pyZip = await createZipFromMap({
    'python-web/app.py': `
import json, os
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/api/info':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': True, 'runtime': 'python3'}).encode())
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(b'<h1>Python App Live</h1>')
    def log_message(self, format, *args):
        pass

port = int(os.environ.get('PORT', '8000'))
HTTPServer(('127.0.0.1', port), Handler).serve_forever()
`,
  });
  const pyRes = await uploadAndDeployZip(token, 'python-app.zip', pyZip);
  const pyProj = pyRes.project as {
    id: string;
    slug: string;
    status: string;
    framework: string;
    live_url: string | null;
    preview_url: string | null;
  };
  assertDeployedStatus(pyProj, publicHostingReady, 'Python deploy');
  const pyHome = await (await fetch(`${BASE_URL}/sites/${pyProj.slug}/`)).text();
  const pyApi = await (await fetch(`${BASE_URL}/sites/${pyProj.slug}/api/info`)).json();
  if (!pyHome.includes('Python App Live') || !pyApi.ok) {
    throw new Error('Python app verification failed');
  }
  console.log(`   PASS: Python app verified (${pyProj.status}, API ok=${pyApi.ok})`);

  console.log('4. Testing Real React + Vite Build & Deploy...');
  const viteZip = await createZipFromMap({
    'vite-react-demo/package.json': JSON.stringify({
      name: 'vite-react-demo',
      private: true,
      version: '1.0.0',
      type: 'module',
      scripts: { build: 'vite build' },
      dependencies: { react: '^19.0.1', 'react-dom': '^19.0.1' },
      devDependencies: { '@vitejs/plugin-react': '^6.1.1', vite: '^8.3.0' },
    }),
    'vite-react-demo/vite.config.js': `
      import { defineConfig } from 'vite';
      import react from '@vitejs/plugin-react';
      export default defineConfig({ plugins: [react()] });
    `,
    'vite-react-demo/index.html':
      '<!doctype html><html><head><title>Vite React</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
    'vite-react-demo/src/main.jsx': `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      createRoot(document.getElementById('root')).render(React.createElement('h1', null, 'Vite React Built Live'));
    `,
  });
  const viteRes = await uploadAndDeployZip(token, 'vite-react.zip', viteZip);
  const viteProj = viteRes.project as {
    id: string;
    slug: string;
    status: string;
    framework: string;
    live_url: string | null;
    preview_url: string | null;
  };
  assertDeployedStatus(viteProj, publicHostingReady, 'Vite deploy');
  const viteHtml = await (await fetch(`${BASE_URL}/sites/${viteProj.slug}/`)).text();
  if (!viteHtml.includes(`<base href="/sites/${viteProj.slug}/">`) && !viteHtml.includes(`/sites/${viteProj.slug}/assets/`)) {
    throw new Error(`Vite HTML missing mounted path prefix: ${viteHtml}`);
  }
  console.log(`   PASS: React + Vite built & verified (${viteProj.status})`);

  console.log('5. Testing Large Multi-Chunk Resumable Upload (Pause -> Resume)...');
  // Create ~7 MB binary asset inside static ZIP so it splits across >= 4 chunks at 2 MB/chunk
  const largePayload = crypto.randomBytes(7 * 1024 * 1024);
  const largeZip = await createZipFromMap({
    'large-site/index.html': '<h1>Large Multi-Chunk Site</h1>',
    'large-site/data.bin': largePayload,
  });
  const largeRes = await uploadAndDeployZip(token, 'large-bundle.zip', largeZip, {
    testPauseResume: true,
  });
  const largeProj = largeRes.project as {
    id: string;
    slug: string;
    status: string;
    live_url: string | null;
    preview_url: string | null;
  };
  assertDeployedStatus(largeProj, publicHostingReady, 'Large upload deploy');
  const binRes = await fetch(`${BASE_URL}/sites/${largeProj.slug}/data.bin`);
  if (binRes.status !== 200) throw new Error('Large binary asset fetch failed');
  console.log(`   PASS: Multi-chunk pause/resume upload & deploy succeeded (${largeZip.length} bytes)`);

  console.log('6. Testing Security: Workspace Isolation & Path Traversal Rejection...');
  const isoRes = await fetch(`${BASE_URL}/api/projects/${staticProj.id}`, {
    headers: { 'X-Workspace-Token': otherToken },
  });
  if (isoRes.status !== 404) {
    throw new Error(`Workspace isolation failed: expected 404, got ${isoRes.status}`);
  }

  // Craft a literal "../evil.txt" entry inside both ZIP local header and central directory
  const baseEvilZip = await createZipFromMap({
    'aa/evil.txt': 'pwned',
    'index.html': '<h1>Test</h1>',
  });
  const evilBuf = Buffer.from(baseEvilZip);
  const needle = Buffer.from('aa/evil.txt', 'ascii');
  const replacement = Buffer.from('../evil.txt', 'ascii');
  let offset = 0;
  let patchedCount = 0;
  while (true) {
    const idx = evilBuf.indexOf(needle, offset);
    if (idx === -1) break;
    replacement.copy(evilBuf, idx);
    patchedCount++;
    offset = idx + needle.length;
  }
  if (patchedCount < 2) {
    throw new Error('Failed to patch ZIP headers for path traversal test');
  }

  const evilRes = await uploadAndDeployZip(token, 'evil-traversal.zip', evilBuf);
  const evilProj = evilRes.project as { id: string; status: string; error_message: string };
  if (
    evilProj.status !== 'failed' ||
    (!evilProj.error_message.toLowerCase().includes('traversal') &&
      !evilProj.error_message.toLowerCase().includes('invalid relative path'))
  ) {
    throw new Error(`Path traversal was not rejected properly: ${JSON.stringify(evilProj)}`);
  }
  console.log(`   PASS: Path traversal blocked (${evilProj.error_message}) & workspace isolation verified`);

  console.log('7. Testing Complete Downloadable Source ZIP Endpoint...');
  const srcZipRes = await fetch(`${BASE_URL}/api/system/source-zip`);
  const srcZipBuf = Buffer.from(await srcZipRes.arrayBuffer());
  if (srcZipRes.status !== 200 || srcZipBuf.length < 10_000) {
    throw new Error(`Source ZIP endpoint failed: status=${srcZipRes.status}, bytes=${srcZipBuf.length}`);
  }
  console.log(`   PASS: Source ZIP downloaded (${(srcZipBuf.length / 1024).toFixed(1)} KB)`);

  // Clean up test projects
  for (const pid of [staticProj.id, nodeProj.id, pyProj.id, viteProj.id, largeProj.id, evilProj.id]) {
    await fetch(`${BASE_URL}/api/projects/${pid}`, {
      method: 'DELETE',
      headers: { 'X-Workspace-Token': token },
    });
  }

  console.log('\nALL E2E VERIFICATION TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('\nTEST FAILURE:', err);
  process.exit(1);
});
