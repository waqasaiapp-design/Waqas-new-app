import crypto from 'node:crypto';
import path from 'node:path';
import type { Request, Response } from 'express';

const WORKSPACE_COOKIE = 'waqas_ws_token';
const TOKEN_REGEX = /^[a-f0-9]{32,64}$/;

export function generateId(bytes = 12): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sanitizeSlug(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/\.zip$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${cleaned || 'site'}-${suffix}`;
}

/**
 * Confinement guard to prevent path traversal outside baseDir.
 */
export function resolveSafePath(baseDir: string, untrustedRelative: string): string {
  const normalizedInput = untrustedRelative.replace(/\\/g, '/');
  if (normalizedInput.startsWith('/') || /^[a-zA-Z]:/.test(normalizedInput)) {
    throw new Error(`Unsafe absolute path rejected: ${untrustedRelative}`);
  }
  if (normalizedInput.includes('\0')) {
    throw new Error('Null byte in path rejected');
  }
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, normalizedInput);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Path traversal attempt rejected: ${untrustedRelative}`);
  }
  return resolvedTarget;
}

/**
 * Parses cookie header cleanly without extra dependencies.
 */
function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    out[key] = val;
  }
  return out;
}

/**
 * Resolves the caller's workspace token for isolating one user's uploads/projects from another's.
 * Supports both X-Workspace-Token header and HttpOnly Partitioned cookie.
 */
export function resolveWorkspaceToken(req: Request, res?: Response): string {
  const headerToken = req.header('x-workspace-token')?.trim();
  if (headerToken && TOKEN_REGEX.test(headerToken)) {
    return headerToken;
  }
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies[WORKSPACE_COOKIE];
  if (cookieToken && TOKEN_REGEX.test(cookieToken)) {
    return cookieToken;
  }
  const freshToken = crypto.randomBytes(24).toString('hex');
  if (res) {
    const isHttps = req.secure || req.header('x-forwarded-proto') === 'https';
    const parts = [
      `${WORKSPACE_COOKIE}=${freshToken}`,
      'Path=/',
      'HttpOnly',
      'Max-Age=2592000',
    ];
    if (isHttps) {
      parts.push('SameSite=None', 'Secure', 'Partitioned');
    } else {
      parts.push('SameSite=Lax');
    }
    res.setHeader('Set-Cookie', parts.join('; '));
  }
  return freshToken;
}

/**
 * Creates a scrubbed environment for user build and runtime processes.
 * Never leaks GEMINI_API_KEY, S3 secrets, or main application credentials.
 */
export function createIsolatedChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const safeKeys = [
    'PATH',
    'HOME',
    'USER',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'XDG_CACHE_HOME',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'npm_config_nodedir',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of safeKeys) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  if (!env.PATH) {
    env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  }
  return {
    ...env,
    CI: 'true',
    ...extra,
  };
}
