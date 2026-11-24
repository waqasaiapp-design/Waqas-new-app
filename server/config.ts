import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type PublicHostingProviderKind =
  | 'vercel'
  | 'wildcard-domain'
  | 'custom-public-host'
  | 'private-preview';

export interface AppConfig {
  port: number;
  publicSitesPort: number;
  appUrl: string;
  publicBaseDomain: string;
  publicHostingUrl: string;
  dataDir: string;
  uploadsDir: string;
  workspacesDir: string;
  artifactsDir: string;
  npmCacheDir: string;
  dbPath: string;
  chunkSizeBytes: number;
  maxChunkSizeBytes: number;
  maxUploadBytes: number;
  maxExtractBytes: number;
  maxExtractFiles: number;
  buildTimeoutMs: number;
  appMemoryLimitMb: number;
  cleanupAbandonedHours: number;
  hostingProviders: {
    vercelToken: string;
    vercelTeamId: string;
  };
  s3: {
    enabled: boolean;
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
}

export interface HostCapabilities {
  storageDriver: 's3-multipart' | 'local-multipart';
  diskTotalBytes: number;
  diskAvailableBytes: number;
  memoryTotalBytes: number;
  memoryFreeBytes: number;
  effectiveMaxUploadBytes: number;
  chunkSizeBytes: number;
  maxChunkSizeBytes: number;
  maxExtractBytes: number;
  maxExtractFiles: number;
  buildTimeoutMs: number;
  appMemoryLimitMb: number;
  publicRoutingMode: 'subdomain-and-path' | 'path-only' | 'external-provider';
  publicBaseDomain: string;
  publicHostingProvider: PublicHostingProviderKind;
  publicHostingReady: boolean;
  publicHostingOrigin: string | null;
  isAiStudioPrivatePreview: boolean;
  publicHostingDiagnostic: string | null;
  hostingSetup: {
    primaryProviderName: string;
    primaryProviderReady: boolean;
    containerRuntimeName: string;
    containerRuntimeReady: boolean;
    controlPlaneOrigin: string | null;
    controlPlaneIsPrivatePreview: boolean;
    requiredSecrets: Array<{
      envVar: string;
      category: 'primary-provider' | 'container-runtime';
      required: boolean;
      requiredFor: string;
      configured: boolean;
      description: string;
      whereToGet: string;
    }>;
  };
  runtimes: {
    node: { available: boolean; version: string | null };
    npm: { available: boolean; version: string | null };
    pnpm: { available: boolean; version: string | null };
    yarn: { available: boolean; version: string | null };
    bun: { available: boolean; version: string | null };
    python3: { available: boolean; version: string | null };
    pip: { available: boolean; version: string | null };
    docker: { available: boolean; version: string | null; daemonRunning: boolean };
  };
  missingExternalInfra: string[];
}

function parsePositiveInt(val: string | undefined, fallback: number): number {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function isPrivateOrAiStudioPreviewUrl(rawUrl: string): {
  restricted: boolean;
  reason?: string;
} {
  if (!rawUrl) {
    return { restricted: true, reason: 'No public origin URL is configured.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { restricted: true, reason: `Invalid URL '${rawUrl}'.` };
  }
  const host = parsed.hostname.toLowerCase();
  if (
    /^ais-dev-/.test(host) ||
    host.includes('.ais-dev-') ||
    host === 'aistudio.google.com' ||
    host.endsWith('.aistudio.google.com')
  ) {
    return {
      restricted: true,
      reason: `Host '${host}' is a private Google AI Studio development preview proxy that requires Google authentication and returns 403 Forbidden to external visitors.`,
    };
  }
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^169\.254\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    return {
      restricted: true,
      reason: `Host '${host}' is a private/local address and is not reachable from public devices.`,
    };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { restricted: true, reason: `Unsupported protocol '${parsed.protocol}'.` };
  }
  return { restricted: false };
}

const rootDataDir = path.resolve(process.cwd(), process.env.DATA_DIR || './data');

export const config: AppConfig = {
  port: parsePositiveInt(process.env.PORT, 3000),
  publicSitesPort: parsePositiveInt(process.env.PUBLIC_SITES_PORT, 0),
  appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
  publicBaseDomain: (process.env.PUBLIC_BASE_DOMAIN || '').trim().toLowerCase(),
  publicHostingUrl: (process.env.PUBLIC_HOSTING_URL || '').trim().replace(/\/+$/, ''),
  dataDir: rootDataDir,
  uploadsDir: path.join(rootDataDir, 'uploads'),
  workspacesDir: path.join(rootDataDir, 'workspaces'),
  artifactsDir: path.join(rootDataDir, 'artifacts'),
  npmCacheDir: path.join(rootDataDir, '.npm-cache'),
  dbPath: path.join(rootDataDir, 'waqas_zip_to_web.sqlite'),
  chunkSizeBytes: parsePositiveInt(process.env.CHUNK_SIZE_BYTES, 4 * 1024 * 1024),
  maxChunkSizeBytes: parsePositiveInt(process.env.MAX_CHUNK_SIZE_BYTES, 32 * 1024 * 1024),
  maxUploadBytes: parsePositiveInt(process.env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024 * 1024),
  maxExtractBytes: parsePositiveInt(process.env.MAX_EXTRACT_BYTES, 2 * 1024 * 1024 * 1024),
  maxExtractFiles: parsePositiveInt(process.env.MAX_EXTRACT_FILES, 25000),
  buildTimeoutMs: parsePositiveInt(process.env.BUILD_TIMEOUT_MS, 300000),
  appMemoryLimitMb: parsePositiveInt(process.env.APP_MEMORY_LIMIT_MB, 512),
  cleanupAbandonedHours: parsePositiveInt(process.env.CLEANUP_ABANDONED_HOURS, 24),
  hostingProviders: {
    vercelToken: (process.env.VERCEL_TOKEN || '').trim(),
    vercelTeamId: (process.env.VERCEL_TEAM_ID || process.env.VERCEL_ORG_ID || '').trim(),
  },
  s3: {
    enabled: Boolean(
      process.env.S3_BUCKET &&
        process.env.S3_ACCESS_KEY_ID &&
        process.env.S3_SECRET_ACCESS_KEY
    ),
    endpoint: (process.env.S3_ENDPOINT || '').trim(),
    region: (process.env.S3_REGION || 'auto').trim(),
    bucket: (process.env.S3_BUCKET || '').trim(),
    accessKeyId: (process.env.S3_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: (process.env.S3_SECRET_ACCESS_KEY || '').trim(),
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  },
};

export function hasPublicContainerRuntime(): boolean {
  if (config.publicBaseDomain) {
    if (!isPrivateOrAiStudioPreviewUrl(`https://${config.publicBaseDomain}`).restricted) {
      return true;
    }
  }
  if (config.publicHostingUrl) {
    if (!isPrivateOrAiStudioPreviewUrl(config.publicHostingUrl).restricted) {
      return true;
    }
  }
  if (config.appUrl && !isPrivateOrAiStudioPreviewUrl(config.appUrl).restricted) {
    return true;
  }
  return false;
}

export function resolvePublicHostingConfig(): {
  provider: PublicHostingProviderKind;
  ready: boolean;
  origin: string | null;
  isAiStudioPrivatePreview: boolean;
  containerRuntimeReady: boolean;
  vercelReady: boolean;
  diagnostic: string | null;
} {
  const aiStudioCheck = isPrivateOrAiStudioPreviewUrl(config.appUrl);
  const isAiStudioPrivate = Boolean(config.appUrl && /^https?:\/\/ais-dev-/.test(config.appUrl));
  const vercelReady = Boolean(config.hostingProviders.vercelToken);
  const containerReady = hasPublicContainerRuntime();

  if (config.publicBaseDomain) {
    const check = isPrivateOrAiStudioPreviewUrl(`https://${config.publicBaseDomain}`);
    if (!check.restricted) {
      return {
        provider: 'wildcard-domain',
        ready: true,
        origin: `https://${config.publicBaseDomain}`,
        isAiStudioPrivatePreview: isAiStudioPrivate,
        containerRuntimeReady: true,
        vercelReady,
        diagnostic: null,
      };
    }
  }

  if (config.publicHostingUrl) {
    const check = isPrivateOrAiStudioPreviewUrl(config.publicHostingUrl);
    if (!check.restricted) {
      return {
        provider: 'custom-public-host',
        ready: true,
        origin: config.publicHostingUrl,
        isAiStudioPrivatePreview: isAiStudioPrivate,
        containerRuntimeReady: true,
        vercelReady,
        diagnostic: null,
      };
    }
  }

  if (vercelReady) {
    return {
      provider: 'vercel',
      ready: true,
      origin: 'https://vercel.app',
      isAiStudioPrivatePreview: isAiStudioPrivate,
      containerRuntimeReady: containerReady,
      vercelReady: true,
      diagnostic: null,
    };
  }

  // Only treat APP_URL as public container host when it is NOT ais-dev / localhost / private
  if (config.appUrl && !aiStudioCheck.restricted) {
    return {
      provider: 'custom-public-host',
      ready: true,
      origin: config.appUrl,
      isAiStudioPrivatePreview: false,
      containerRuntimeReady: true,
      vercelReady,
      diagnostic: null,
    };
  }

  return {
    provider: 'private-preview',
    ready: false,
    origin: null,
    isAiStudioPrivatePreview: isAiStudioPrivate,
    containerRuntimeReady: false,
    vercelReady: false,
    diagnostic:
      aiStudioCheck.reason ||
      'No public HTTPS hosting provider or container runtime domain is configured on this server.',
  };
}

export function ensureDataDirectories(): void {
  for (const dir of [
    config.dataDir,
    config.uploadsDir,
    config.workspacesDir,
    config.artifactsDir,
    config.npmCacheDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function probeBinary(cmd: string, args: string[]): Promise<{ ok: boolean; out: string | null }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 3000 });
    const text = (stdout || stderr || '').trim().split('\n')[0] || null;
    return { ok: true, out: text };
  } catch {
    return { ok: false, out: null };
  }
}

let cachedRuntimes: HostCapabilities['runtimes'] | null = null;
let cachedAt = 0;

export async function probeHostCapabilities(forceRefresh = false): Promise<HostCapabilities> {
  ensureDataDirectories();
  let diskTotalBytes = 0;
  let diskAvailableBytes = 0;
  try {
    const stat = fs.statfsSync(config.dataDir);
    diskTotalBytes = Number(stat.blocks) * Number(stat.bsize);
    diskAvailableBytes = Number(stat.bavail) * Number(stat.bsize);
  } catch {
    diskTotalBytes = 0;
    diskAvailableBytes = 0;
  }

  const memoryTotalBytes = os.totalmem();
  const memoryFreeBytes = os.freemem();

  const now = Date.now();
  if (!cachedRuntimes || forceRefresh || now - cachedAt > 60_000) {
    const [nodeRes, npmRes, pnpmRes, yarnRes, bunRes, pyRes, pipRes, dockerVerRes, dockerInfoRes] =
      await Promise.all([
        probeBinary('node', ['-v']),
        probeBinary('npm', ['-v']),
        probeBinary('pnpm', ['-v']),
        probeBinary('yarn', ['-v']),
        probeBinary('bun', ['--version']),
        probeBinary('python3', ['--version']),
        probeBinary('python3', ['-m', 'pip', '--version']),
        probeBinary('docker', ['--version']),
        probeBinary('docker', ['info', '--format', '{{.ServerVersion}}']),
      ]);

    cachedRuntimes = {
      node: { available: nodeRes.ok, version: nodeRes.out },
      npm: { available: npmRes.ok, version: npmRes.out },
      pnpm: { available: pnpmRes.ok, version: pnpmRes.out },
      yarn: { available: yarnRes.ok, version: yarnRes.out },
      bun: { available: bunRes.ok, version: bunRes.out },
      python3: { available: pyRes.ok, version: pyRes.out },
      pip: { available: pipRes.ok, version: pipRes.out },
      docker: {
        available: dockerVerRes.ok,
        version: dockerVerRes.out,
        daemonRunning: dockerInfoRes.ok,
      },
    };
    cachedAt = now;
  }

  const storageDriver = config.s3.enabled ? 's3-multipart' : 'local-multipart';
  const effectiveChunkSize =
    storageDriver === 's3-multipart'
      ? Math.max(config.chunkSizeBytes, 5 * 1024 * 1024)
      : config.chunkSizeBytes;
  const maxChunkSizeBytes =
    storageDriver === 's3-multipart'
      ? Math.max(config.maxChunkSizeBytes, 16 * 1024 * 1024)
      : Math.min(config.maxChunkSizeBytes, 16 * 1024 * 1024);

  const effectiveMaxUploadBytes =
    storageDriver === 's3-multipart'
      ? config.maxUploadBytes
      : Math.min(config.maxUploadBytes, Math.max(0, Math.floor(diskAvailableBytes * 0.75)));

  const hosting = resolvePublicHostingConfig();
  const missingExternalInfra: string[] = [];

  if (!hosting.ready) {
    missingExternalInfra.push(
      `Public Hosting Credentials Missing: ${hosting.diagnostic} Add VERCEL_TOKEN in server environment secrets for managed public hosting (Static, React, Vite, Next.js), or configure PUBLIC_BASE_DOMAIN / PUBLIC_HOSTING_URL on a public Cloud Run / Docker host.`
    );
  } else if (hosting.provider === 'vercel' && !hosting.containerRuntimeReady) {
    missingExternalInfra.push(
      'Vercel is active for HTML/CSS/JS, React, Vite, and Next.js deployments. For persistent Node.js, Python, or Dockerfile server processes, deploy WAQAS ZIP TO WEB on an unauthenticated Cloud Run or Docker host with PUBLIC_BASE_DOMAIN or PUBLIC_HOSTING_URL.'
    );
  }
  if (!config.s3.enabled) {
    missingExternalInfra.push(
      'External S3/R2 object storage (S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY) is not configured — using parallel local disk multipart streaming bounded by host disk capacity.'
    );
  }
  if (!cachedRuntimes.docker.daemonRunning) {
    missingExternalInfra.push(
      'Docker daemon is unavailable in this container runtime — Dockerfile builds cannot execute here, and Node.js/Python apps run in isolated OS child processes rather than Docker containers.'
    );
  }
  if (!cachedRuntimes.pip.available) {
    missingExternalInfra.push(
      'Python pip is not installed in this container — Python standard-library web servers run natively, while third-party requirements.txt packages require a Docker/pip host.'
    );
  }

  const routingMode =
    hosting.provider === 'wildcard-domain'
      ? 'subdomain-and-path'
      : hosting.provider === 'vercel'
        ? 'external-provider'
        : 'path-only';

  return {
    storageDriver,
    diskTotalBytes,
    diskAvailableBytes,
    memoryTotalBytes,
    memoryFreeBytes,
    effectiveMaxUploadBytes,
    chunkSizeBytes: effectiveChunkSize,
    maxChunkSizeBytes,
    maxExtractBytes: Math.min(config.maxExtractBytes, Math.max(0, Math.floor(diskAvailableBytes * 0.6))),
    maxExtractFiles: config.maxExtractFiles,
    buildTimeoutMs: config.buildTimeoutMs,
    appMemoryLimitMb: config.appMemoryLimitMb,
    publicRoutingMode: routingMode,
    publicBaseDomain: config.publicBaseDomain,
    publicHostingProvider: hosting.provider,
    publicHostingReady: hosting.ready,
    publicHostingOrigin: hosting.origin,
    isAiStudioPrivatePreview: hosting.isAiStudioPrivatePreview,
    publicHostingDiagnostic: hosting.diagnostic,
    hostingSetup: {
      primaryProviderName: 'Vercel',
      primaryProviderReady: hosting.vercelReady,
      containerRuntimeName: 'Public Container / Cloud Run / Docker Host',
      containerRuntimeReady: hosting.containerRuntimeReady,
      controlPlaneOrigin: config.appUrl || null,
      controlPlaneIsPrivatePreview: hosting.isAiStudioPrivatePreview,
      requiredSecrets: [
        {
          envVar: 'VERCEL_TOKEN',
          category: 'primary-provider',
          required: true,
          requiredFor: 'HTML/CSS/JS, React, Vite, and Next.js (Static & SSR)',
          configured: Boolean(config.hostingProviders.vercelToken),
          description: 'Vercel personal or team access token used by the backend Deployment API (v13) to publish public HTTPS websites outside Google AI Studio.',
          whereToGet: 'Vercel Dashboard -> Account Settings -> Tokens -> Create Token',
        },
        {
          envVar: 'VERCEL_TEAM_ID',
          category: 'primary-provider',
          required: false,
          requiredFor: 'Optional Vercel Team scope',
          configured: Boolean(config.hostingProviders.vercelTeamId),
          description: 'Team/Org ID (team_xxx) when deploying under a Vercel Team rather than a personal hobby account.',
          whereToGet: 'Vercel Team Settings -> General -> Team ID',
        },
        {
          envVar: 'PUBLIC_BASE_DOMAIN',
          category: 'container-runtime',
          required: false,
          requiredFor: 'Node.js, Python & Dockerfile server apps (wildcard subdomains)',
          configured: Boolean(config.publicBaseDomain && !isPrivateOrAiStudioPreviewUrl(`https://${config.publicBaseDomain}`).restricted),
          description: 'Wildcard public domain pointing to your Docker/Caddy VPS (e.g. sites.yourdomain.com -> https://<slug>.sites.yourdomain.com/).',
          whereToGet: 'Domain DNS (*.sites.yourdomain.com A/AAAA record) + VPS .env',
        },
        {
          envVar: 'PUBLIC_HOSTING_URL',
          category: 'container-runtime',
          required: false,
          requiredFor: 'Node.js, Python & Dockerfile server apps (path-routed public host)',
          configured: Boolean(config.publicHostingUrl && !isPrivateOrAiStudioPreviewUrl(config.publicHostingUrl).restricted),
          description: 'Public unauthenticated origin URL (e.g. Cloud Run --allow-unauthenticated HTTPS URL, never ais-dev-*.run.app).',
          whereToGet: 'Public Cloud Run Service URL or VPS HTTPS domain',
        },
      ],
    },
    runtimes: cachedRuntimes,
    missingExternalInfra,
  };
}
