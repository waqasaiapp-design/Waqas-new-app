import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  config,
  isPrivateOrAiStudioPreviewUrl,
  resolvePublicHostingConfig,
  type PublicHostingProviderKind,
} from './config.ts';
import type { ProjectFramework, PublicVerificationReport } from './db.ts';

/**
 * Ensures all directories (0755) and files (0644) in static deployment output are world-readable
 * so reverse proxies and web servers never hit POSIX 403 Permission Denied errors.
 */
export async function ensurePublicReadablePermissions(rootDir: string): Promise<void> {
  if (!fs.existsSync(rootDir)) return;
  const walk = async (dir: string) => {
    await fsp.chmod(dir, 0o755).catch(() => {});
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(abs);
      } else if (ent.isFile()) {
        await fsp.chmod(abs, 0o644).catch(() => {});
      }
    }
  };
  await walk(rootDir);
}

const SKIPPED_SOURCE_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  '.waqas-backup',
  '.vercel',
  '.turbo',
]);

async function collectFilesForVercel(
  rootDir: string,
  skipBuildCaches: boolean
): Promise<Array<{ file: string; data: string; encoding: 'base64' }>> {
  const out: Array<{ file: string; data: string; encoding: 'base64' }> = [];
  const walk = async (dir: string, relBase: string) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (skipBuildCaches && SKIPPED_SOURCE_DIRS.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(abs, rel);
      } else if (ent.isFile()) {
        const content = await fsp.readFile(abs);
        out.push({
          file: rel,
          data: content.toString('base64'),
          encoding: 'base64',
        });
      }
    }
  };
  await walk(rootDir, '');
  return out;
}

/**
 * Primary Managed Public Hosting Provider: Vercel Deployments v13 API.
 * - Static HTML/CSS/JS: deploys static files with framework=null.
 * - React / Vite: deploys built dist/ or build/ output with SPA fallback rewrite rule.
 * - Next.js Static Export: deploys built out/ directory with framework=null.
 * - Next.js SSR: deploys project source tree with framework="nextjs" for server-side execution.
 */
export async function publishToVercelPublicHost(params: {
  slug: string;
  framework: ProjectFramework;
  isStatic: boolean;
  artifactDir: string;
  projectRootDir: string;
  onLog: (level: 'info' | 'success' | 'error', msg: string) => void;
}): Promise<{ url: string; provider: PublicHostingProviderKind }> {
  const token = config.hostingProviders.vercelToken;
  const teamId = config.hostingProviders.vercelTeamId;
  if (!token) {
    throw new Error('VERCEL_TOKEN is not configured in server environment secrets.');
  }

  const isNextJsServer = params.framework === 'nextjs' && !params.isStatic;
  const uploadDir = isNextJsServer ? params.projectRootDir : params.artifactDir;
  const projectName = `waqas-${params.slug}`.slice(0, 62).replace(/[^a-z0-9-]/g, '-');

  params.onLog(
    'info',
    isNextJsServer
      ? `Deploying Next.js SSR application (${projectName}) to Vercel server-side runtime...`
      : `Deploying built ${params.framework} output (${projectName}) to Vercel public edge...`
  );

  const vercelFiles = await collectFilesForVercel(uploadDir, isNextJsServer);
  if (vercelFiles.length === 0) {
    throw new Error(`No deployable files found in ${uploadDir}.`);
  }

  // Ensure React/Vite SPAs serve index.html on client-side subpaths
  const isSpaFramework = params.framework === 'react' || params.framework === 'vite';
  const hasVercelConfig = vercelFiles.some((f) => f.file.toLowerCase() === 'vercel.json');
  if (isSpaFramework && !hasVercelConfig) {
    const spaConfig = JSON.stringify(
      {
        rewrites: [{ source: '/(.*)', destination: '/index.html' }],
      },
      null,
      2
    );
    vercelFiles.push({
      file: 'vercel.json',
      data: Buffer.from(spaConfig, 'utf8').toString('base64'),
      encoding: 'base64',
    });
  }

  const teamQuery = teamId ? `&teamId=${encodeURIComponent(teamId)}` : '';
  const createRes = await fetch(
    `https://api.vercel.com/v13/deployments?skipAutoDetectionConfirmation=1${teamQuery}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: projectName,
        files: vercelFiles,
        public: true,
        target: 'production',
        projectSettings: {
          framework: isNextJsServer ? 'nextjs' : null,
        },
      }),
    }
  );

  if (!createRes.ok) {
    const errText = await createRes.text().catch(() => '');
    throw new Error(
      `Vercel deployment API failed (HTTP ${createRes.status}): ${errText.slice(0, 280)}`
    );
  }

  const created = (await createRes.json()) as {
    id?: string;
    url?: string;
    alias?: string[];
    readyState?: string;
  };

  let finalHost = (created.alias && created.alias[0]) || created.url || '';
  const statusQuery = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';

  // Wait for remote build/propagation (longer window for Next.js SSR server builds)
  if (created.id && created.readyState !== 'READY') {
    const maxPolls = isNextJsServer ? 60 : 25;
    for (let i = 0; i < maxPolls; i++) {
      const checkRes = await fetch(
        `https://api.vercel.com/v13/deployments/${encodeURIComponent(created.id)}${statusQuery}`,
        { headers: { Authorization: `Bearer ${token}` } }
      ).catch(() => null);

      if (checkRes?.ok) {
        const st = (await checkRes.json()) as {
          readyState?: string;
          url?: string;
          alias?: string[];
          errorMessage?: string;
        };
        if (st.alias && st.alias[0]) {
          finalHost = st.alias[0];
        } else if (st.url) {
          finalHost = st.url;
        }
        if (st.readyState === 'READY') {
          break;
        }
        if (st.readyState === 'ERROR' || st.readyState === 'CANCELED') {
          throw new Error(
            `Vercel remote build entered state '${st.readyState}'${st.errorMessage ? `: ${st.errorMessage}` : '.'}`
          );
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (!finalHost) {
    throw new Error('Vercel deployment completed without returning a public hostname.');
  }

  const finalUrl = finalHost.startsWith('http') ? finalHost : `https://${finalHost}`;
  const normalizedUrl = finalUrl.endsWith('/') ? finalUrl : `${finalUrl}/`;
  return { url: normalizedUrl, provider: 'vercel' };
}

/**
 * Independent, unauthenticated external HTTP verification check (no cookies, no workspace token).
 * Inspects redirects, blocks AI Studio auth walls / Vercel SSO / 401 / 403 / 404 / 5xx,
 * and verifies linked JS/CSS assets load externally.
 */
export async function verifyPublicLiveWebsite(targetUrl: string): Promise<PublicVerificationReport> {
  const verifiedAt = Date.now();
  const originCheck = isPrivateOrAiStudioPreviewUrl(targetUrl);
  if (originCheck.restricted) {
    const probe = await probeUnauthenticatedHttp(targetUrl, 4).catch(() => null);
    return {
      ok: false,
      checkedUrl: targetUrl,
      finalUrl: probe?.finalUrl ?? null,
      httpStatus: probe?.status ?? 403,
      authWallDetected: true,
      redirectChain: probe?.redirectChain ?? [],
      assetsChecked: 0,
      failedAssets: [],
      error: `${originCheck.reason}${probe?.status ? ` (unauthenticated probe returned HTTP ${probe.status}${probe.authRedirect ? ` -> ${probe.authRedirect}` : ''})` : ''}`,
      verifiedAt,
    };
  }

  let mainProbe: Awaited<ReturnType<typeof probeUnauthenticatedHttp>> | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    mainProbe = await probeUnauthenticatedHttp(targetUrl, 5);
    if (mainProbe.ok && !mainProbe.authWallDetected) break;
    if (mainProbe.status === 403 || mainProbe.status === 401 || mainProbe.authWallDetected) break;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 900));
  }

  if (!mainProbe || !mainProbe.ok || mainProbe.authWallDetected) {
    return {
      ok: false,
      checkedUrl: targetUrl,
      finalUrl: mainProbe?.finalUrl ?? null,
      httpStatus: mainProbe?.status ?? null,
      authWallDetected: Boolean(mainProbe?.authWallDetected),
      redirectChain: mainProbe?.redirectChain ?? [],
      assetsChecked: 0,
      failedAssets: [],
      error:
        mainProbe?.error ||
        `Public URL verification failed with HTTP ${mainProbe?.status ?? 'unreachable'}.`,
      verifiedAt,
    };
  }

  const finalBase = mainProbe.finalUrl || targetUrl;
  const assetUrls = extractAssetUrlsFromHtml(mainProbe.bodyText, finalBase).slice(0, 10);
  const failedAssets: Array<{ url: string; status: number | null; error?: string }> = [];

  for (const assetUrl of assetUrls) {
    const assetProbe = await probeUnauthenticatedHttp(assetUrl, 3);
    if (!assetProbe.ok || assetProbe.authWallDetected) {
      failedAssets.push({
        url: assetUrl,
        status: assetProbe.status,
        error: assetProbe.error || (assetProbe.authWallDetected ? 'Auth redirect on asset' : undefined),
      });
    }
  }

  if (failedAssets.length > 0) {
    return {
      ok: false,
      checkedUrl: targetUrl,
      finalUrl: finalBase,
      httpStatus: mainProbe.status,
      authWallDetected: false,
      redirectChain: mainProbe.redirectChain,
      assetsChecked: assetUrls.length,
      failedAssets,
      error: `${failedAssets.length} asset(s) failed unauthenticated public check (e.g. ${failedAssets[0].url} returned ${failedAssets[0].status ?? failedAssets[0].error}).`,
      verifiedAt,
    };
  }

  return {
    ok: true,
    checkedUrl: targetUrl,
    finalUrl: finalBase,
    httpStatus: mainProbe.status,
    authWallDetected: false,
    redirectChain: mainProbe.redirectChain,
    assetsChecked: assetUrls.length,
    failedAssets: [],
    error: null,
    verifiedAt,
  };
}

async function probeUnauthenticatedHttp(
  urlStr: string,
  maxRedirects: number
): Promise<{
  ok: boolean;
  status: number | null;
  finalUrl: string;
  redirectChain: string[];
  authWallDetected: boolean;
  authRedirect: string | null;
  bodyText: string;
  error: string | null;
}> {
  let current = urlStr;
  const redirectChain: string[] = [];

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let res: Response;
    try {
      res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(9000),
        headers: {
          'User-Agent': 'WaqasZipToWeb-PublicVerifier/1.0',
          Accept: 'text/html,application/xhtml+xml,application/javascript,text/css,*/*',
        },
      });
    } catch (err) {
      return {
        ok: false,
        status: null,
        finalUrl: current,
        redirectChain,
        authWallDetected: false,
        authRedirect: null,
        bodyText: '',
        error: `External request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const status = res.status;
    const location = res.headers.get('location');
    const setCookie = (res.headers.get('set-cookie') || '').toLowerCase();

    if (
      setCookie.includes('aistudio_auth_flow') ||
      (location &&
        (location.includes('__cookie_check.html') ||
          location.includes('accounts.google.com') ||
          location.includes('ServiceLogin') ||
          location.includes('vercel.com/sso-api')))
    ) {
      const isVercelSso = Boolean(location && location.includes('vercel.com/sso-api'));
      return {
        ok: false,
        status: isVercelSso ? 401 : 403,
        finalUrl: current,
        redirectChain: [...redirectChain, `${status} -> ${location || 'auth-cookie'}`],
        authWallDetected: true,
        authRedirect: location,
        bodyText: '',
        error: isVercelSso
          ? 'Vercel Deployment Protection (SSO Authentication) is blocking anonymous visitors. Disable Vercel Authentication in Vercel Project Settings -> Deployment Protection.'
          : `HTTP ${status} redirected to Google authentication gate (${location || '__cookie_check.html'}), causing 403 Forbidden on public devices.`,
      };
    }

    if (status >= 300 && status < 400 && location) {
      const nextUrl = new URL(location, current).toString();
      redirectChain.push(`${status} -> ${nextUrl}`);
      current = nextUrl;
      continue;
    }

    const bodyText = await res.text().catch(() => '');
    const lowerBody = bodyText.toLowerCase();
    const bodyIndicatesForbidden =
      status === 403 ||
      status === 401 ||
      (lowerBody.includes('403 forbidden') && lowerBody.includes('do not have access')) ||
      (lowerBody.includes('authentication required') && lowerBody.includes('vercel'));

    if (bodyIndicatesForbidden) {
      return {
        ok: false,
        status: status === 401 ? 401 : 403,
        finalUrl: current,
        redirectChain,
        authWallDetected: true,
        authRedirect: null,
        bodyText: bodyText.slice(0, 500),
        error:
          lowerBody.includes('vercel')
            ? `HTTP ${status}: Vercel Deployment Protection is enabled for this deployment. Disable Deployment Protection in Vercel Project Settings.`
            : `HTTP ${status} Forbidden: public visitors do not have access to ${current}.`,
      };
    }

    if (status >= 400) {
      return {
        ok: false,
        status,
        finalUrl: current,
        redirectChain,
        authWallDetected: false,
        authRedirect: null,
        bodyText: bodyText.slice(0, 500),
        error: `Public endpoint returned HTTP ${status} for ${current}.`,
      };
    }

    return {
      ok: true,
      status,
      finalUrl: current,
      redirectChain,
      authWallDetected: false,
      authRedirect: null,
      bodyText,
      error: null,
    };
  }

  return {
    ok: false,
    status: null,
    finalUrl: current,
    redirectChain,
    authWallDetected: false,
    authRedirect: null,
    bodyText: '',
    error: `Too many redirects while probing ${urlStr}.`,
  };
}

function extractAssetUrlsFromHtml(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  const baseObj = new URL(baseUrl);
  let effectiveBase = baseObj;
  const baseTagMatch = html.match(/<base\b[^>]*href=["']([^"']+)["']/i);
  if (baseTagMatch?.[1]) {
    try {
      effectiveBase = new URL(baseTagMatch[1], baseObj);
    } catch {
      effectiveBase = baseObj;
    }
  }

  const patterns = [
    /<script\b[^>]*\bsrc=["']([^"']+)["']/gi,
    /<link\b[^>]*\brel=["'][^"']*stylesheet[^"']*["'][^>]*\bhref=["']([^"']+)["']/gi,
    /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["'][^"']*stylesheet[^"']*["']/gi,
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const raw = m[1]?.trim();
      if (!raw || raw.startsWith('data:') || raw.startsWith('javascript:') || raw.startsWith('#')) {
        continue;
      }
      try {
        const resolved = new URL(raw, effectiveBase);
        if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
          urls.add(resolved.toString());
        }
      } catch {
        // ignore invalid URI
      }
    }
  }
  return Array.from(urls);
}

/**
 * Generates an explanation and setup instructions when the active host is behind
 * AI Studio's private preview proxy without configured public hosting credentials.
 */
export function explainBlockedPublicDeployment(params: {
  slug: string;
  previewPath: string;
  verification: PublicVerificationReport;
}): { errorMessage: string; hint: string } {
  const hosting = resolvePublicHostingConfig();
  const baseMsg =
    params.verification.error ||
    'Public URL verification failed: external unauthenticated visitors cannot access this link.';

  if (hosting.isAiStudioPrivatePreview && !hosting.ready) {
    return {
      errorMessage: `Public access blocked (HTTP ${params.verification.httpStatus || 403}): ${config.appUrl} is a private Google AI Studio preview URL requiring Google authentication. External devices receive 403 Forbidden.`,
      hint:
        'Open the Public Hosting Setup page to configure VERCEL_TOKEN in server environment secrets (deploys HTML/CSS/JS, React, Vite & Next.js publicly) or deploy to an unauthenticated Cloud Run / Docker host with PUBLIC_BASE_DOMAIN / PUBLIC_HOSTING_URL.',
    };
  }

  return {
    errorMessage: baseMsg,
    hint: 'Verify provider settings (such as Vercel Deployment Protection), DNS, and TLS certificates, then click Re-verify & Publish Public URL.',
  };
}
