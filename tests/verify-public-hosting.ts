import { ZipArchive } from 'archiver';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isPrivateOrAiStudioPreviewUrl } from '../server/config.ts';
import { ensurePublicReadablePermissions, verifyPublicLiveWebsite } from '../server/publicHosting.ts';

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

async function run() {
  console.log('=== PUBLIC HOSTING & 403 PREVENTION VERIFICATION ===');

  // 1. Verify private/AI Studio preview URL classifier blocks all non-public hosts
  console.log('1. Testing private / AI Studio URL rejection...');
  const blockedUrls = [
    'https://ais-dev-abc123.asia-southeast1.run.app/sites/demo/',
    'https://aistudio.google.com/sites/demo/',
    'http://localhost:3000/sites/demo/',
    'http://127.0.0.1:3000/sites/demo/',
    'http://192.168.1.10/sites/demo/',
    'http://10.0.0.5/sites/demo/',
  ];
  for (const u of blockedUrls) {
    const chk = isPrivateOrAiStudioPreviewUrl(u);
    if (!chk.restricted) {
      throw new Error(`Expected '${u}' to be rejected as non-public!`);
    }
  }
  if (isPrivateOrAiStudioPreviewUrl('https://demo.waqas.app/').restricted) {
    throw new Error('Valid public domain was falsely rejected!');
  }
  console.log('   PASS: All private/AI Studio preview URLs rejected cleanly.');

  // 2. Verify POSIX world-readable permission normalization (prevents reverse-proxy 403)
  console.log('2. Testing POSIX 0755/0644 permission repair...');
  const permTmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'waqas-perm-'));
  try {
    const sub = path.join(permTmp, 'assets');
    await fsp.mkdir(sub, { recursive: true });
    const filePath = path.join(sub, 'app.js');
    await fsp.writeFile(filePath, 'console.log(1);');
    await fsp.chmod(filePath, 0o600);
    await fsp.chmod(sub, 0o700);
    await ensurePublicReadablePermissions(permTmp);
    const dirMode = (await fsp.stat(sub)).mode & 0o777;
    const fileMode = (await fsp.stat(filePath)).mode & 0o777;
    if (dirMode !== 0o755 || fileMode !== 0o644) {
      throw new Error(`Permission repair mismatch: dir=${dirMode.toString(8)} file=${fileMode.toString(8)}`);
    }
    console.log('   PASS: Static artifacts normalized to 0755 dirs / 0644 files.');
  } finally {
    await fsp.rm(permTmp, { recursive: true, force: true }).catch(() => {});
  }

  // 3. Verify external unauthenticated probe catches real AI Studio 302 -> __cookie_check.html / 403
  console.log('3. Testing unauthenticated probe against active APP_URL...');
  const appUrl = (process.env.APP_URL || '').trim();
  if (appUrl && appUrl.includes('ais-dev-')) {
    const report = await verifyPublicLiveWebsite(`${appUrl.replace(/\/+$/, '')}/sites/test-probe/`);
    if (report.ok || !report.authWallDetected || report.httpStatus !== 403) {
      throw new Error(`Expected authWallDetected/403 on ${appUrl}, got: ${JSON.stringify(report)}`);
    }
    console.log(
      `   PASS: Unauthenticated probe detected auth gate on APP_URL (status=${report.httpStatus}, error="${report.error}")`
    );
  } else {
    console.log('   SKIP: APP_URL is not an ais-dev preview URL in this shell.');
  }

  // 4. Verify external public non-auth HTTPS check succeeds on a real public website
  console.log('4. Testing positive unauthenticated external HTTPS verifier...');
  const publicReport = await verifyPublicLiveWebsite('https://example.com/');
  if (!publicReport.ok || publicReport.httpStatus !== 200 || publicReport.authWallDetected) {
    throw new Error(`Expected https://example.com/ to pass external check: ${JSON.stringify(publicReport)}`);
  }
  console.log(`   PASS: External unauthenticated check returned HTTP ${publicReport.httpStatus} (ok=true).`);

  // 5. Verify hostingSetup telemetry & full deployment pipeline check
  console.log('5. Testing hostingSetup separation telemetry + deployment + /verify-public + /sites/:slug/...');
  const sessRes = await fetch(`${BASE_URL}/api/session`);
  const sessJson = await sessRes.json();
  const token = sessJson.workspaceToken as string;
  const caps = sessJson.capabilities as {
    publicHostingReady: boolean;
    hostingSetup?: {
      primaryProviderName: string;
      requiredSecrets: Array<{ envVar: string; configured: boolean }>;
    };
  };
  if (
    !caps.hostingSetup ||
    caps.hostingSetup.primaryProviderName !== 'Vercel' ||
    !caps.hostingSetup.requiredSecrets.some((s) => s.envVar === 'VERCEL_TOKEN')
  ) {
    throw new Error(`Unexpected hostingSetup payload: ${JSON.stringify(caps.hostingSetup)}`);
  }
  const publicReady = Boolean(caps.publicHostingReady);

  const zipBuf = await createZipFromMap({
    'pub-check/index.html':
      '<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><h1>Public Check Site</h1><script src="/main.js"></script></body></html>',
    'pub-check/style.css': 'h1 { color: #2563eb; }',
    'pub-check/main.js': 'window.__PUB_OK = true;',
  });

  const initRes = await fetch(`${BASE_URL}/api/uploads/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token },
    body: JSON.stringify({ filename: 'pub-check.zip', totalSize: zipBuf.length }),
  });
  const initData = await initRes.json();
  const sessionId = initData.session.id as string;

  await fetch(`${BASE_URL}/api/uploads/${sessionId}/chunk/0`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Workspace-Token': token },
    body: new Uint8Array(zipBuf),
  });

  const compRes = await fetch(`${BASE_URL}/api/uploads/${sessionId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': token },
    body: '{}',
  });
  const compData = await compRes.json();
  const projectId = compData.project.id as string;

  try {
    let proj: Record<string, unknown> | null = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const pRes = await fetch(`${BASE_URL}/api/projects/${projectId}`, {
        headers: { 'X-Workspace-Token': token },
      });
      const pData = await pRes.json();
      proj = pData.project as Record<string, unknown>;
      if (proj.status === 'live' || proj.status === 'public_blocked' || proj.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 400));
    }

    if (!proj) throw new Error('Project disappeared');
    if (publicReady) {
      if (proj.status !== 'live' || !proj.live_url) {
        throw new Error(`Expected verified live URL when public hosting ready: ${JSON.stringify(proj)}`);
      }
    } else {
      if (proj.status !== 'public_blocked' || proj.live_url !== null) {
        throw new Error(`Expected public_blocked + null live_url: ${JSON.stringify(proj)}`);
      }
      if (typeof proj.error_message !== 'string' || !proj.error_message.includes('403')) {
        throw new Error(`Expected honest 403 explanation, got: ${proj.error_message}`);
      }
    }

    // Verify unauthenticated request to Express route /sites/:slug/ (with ZERO workspace token / cookies) serves HTML + JS + CSS
    const slug = String(proj.slug);
    const htmlRes = await fetch(`${BASE_URL}/sites/${slug}/`);
    const htmlText = await htmlRes.text();
    const cssRes = await fetch(`${BASE_URL}/sites/${slug}/style.css`);
    const jsRes = await fetch(`${BASE_URL}/sites/${slug}/main.js`);
    if (htmlRes.status !== 200 || cssRes.status !== 200 || jsRes.status !== 200 || !htmlText.includes('Public Check Site')) {
      throw new Error(`Unauthenticated /sites/${slug}/ asset check failed`);
    }

    // Trigger explicit POST /api/projects/:id/verify-public
    const verifyRes = await fetch(`${BASE_URL}/api/projects/${projectId}/verify-public`, {
      method: 'POST',
      headers: { 'X-Workspace-Token': token },
    });
    if (!verifyRes.ok) {
      throw new Error(`POST /verify-public failed with ${verifyRes.status}`);
    }
    const verifiedJson = await verifyRes.json();
    if (!verifiedJson.project?.public_verification) {
      throw new Error('Missing public_verification report after /verify-public');
    }
    console.log(
      `   PASS: Site served HTML+CSS+JS cleanly (status=${verifiedJson.project.status}, live_url=${verifiedJson.project.live_url}).`
    );
  } finally {
    await fetch(`${BASE_URL}/api/projects/${projectId}`, {
      method: 'DELETE',
      headers: { 'X-Workspace-Token': token },
    }).catch(() => {});
  }

  console.log('\nALL PUBLIC HOSTING & 403 DIAGNOSTIC TESTS PASSED!');
}

run().catch((err) => {
  console.error('\nPUBLIC HOSTING TEST FAILURE:', err);
  process.exit(1);
});
