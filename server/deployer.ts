import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { Request, Response } from 'express';
import { config, isPrivateOrAiStudioPreviewUrl, probeHostCapabilities } from './config.ts';
import {
  appendBuildLog,
  getProjectById,
  getProjectBySlug,
  listAllLiveProjects,
  updateProject,
  type ProjectRecord,
} from './db.ts';
import { createIsolatedChildEnv, resolveSafePath } from './security.ts';

const activeProcesses = new Map<string, ChildProcess>();

export function parseCommandArgs(command: string): { cmd: string; args: string[] } {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  if (tokens.length === 0) throw new Error('Empty command');
  return { cmd: tokens[0], args: tokens.slice(1) };
}

const ALLOWED_EXECUTABLES = new Set([
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'corepack',
  'node',
  'python3',
  'python',
  'docker',
  'tsc',
  'vite',
  'next',
  'esbuild',
]);

export function assertSafeExecutable(cmd: string): void {
  const base = path.basename(cmd);
  if (!ALLOWED_EXECUTABLES.has(base)) {
    throw new Error(
      `Executable '${base}' is not in the permitted runner list (${Array.from(ALLOWED_EXECUTABLES).join(', ')}).`
    );
  }
}

export async function findAvailablePort(startPort = 4200, endPort = 4999): Promise<number> {
  const usedPorts = new Set<number>();
  for (const p of listAllLiveProjects()) {
    if (p.internal_port) usedPorts.add(p.internal_port);
  }

  for (let port = startPort; port <= endPort; port++) {
    if (usedPorts.has(port)) continue;
    const available = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });
    if (available) return port;
  }
  throw new Error('No available internal hosting ports in range 4200–4999.');
}

export function buildPublicLiveUrl(slug: string): string | null {
  if (config.publicBaseDomain) {
    const candidate = `https://${slug}.${config.publicBaseDomain}/`;
    if (!isPrivateOrAiStudioPreviewUrl(candidate).restricted) {
      return candidate;
    }
  }
  if (config.publicHostingUrl) {
    const candidate = `${config.publicHostingUrl}/sites/${slug}/`;
    if (!isPrivateOrAiStudioPreviewUrl(candidate).restricted) {
      return candidate;
    }
  }
  if (config.appUrl && !isPrivateOrAiStudioPreviewUrl(config.appUrl).restricted) {
    return `${config.appUrl}/sites/${slug}/`;
  }
  return null;
}

export function buildOwnerPreviewUrl(slug: string): string {
  return `/sites/${slug}/`;
}

export async function stopProjectRuntime(projectId: string): Promise<void> {
  const proc = activeProcesses.get(projectId);
  if (proc) {
    activeProcesses.delete(projectId);
    try {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 400));
      if (!proc.killed) {
        proc.kill('SIGKILL');
      }
    } catch {
      // ignore
    }
  }
  const project = getProjectById(projectId);
  if (project?.framework === 'dockerfile') {
    const caps = await probeHostCapabilities();
    if (caps.runtimes.docker.daemonRunning) {
      spawn('docker', ['rm', '-f', `waqas-run-${project.slug}`], { stdio: 'ignore' });
    }
  }
  updateProject(projectId, { pid: null, internal_port: null });
}

export async function startDynamicDeployment(
  project: ProjectRecord,
  projectRootDir: string,
  onLog: (level: 'info' | 'stdout' | 'stderr' | 'success' | 'error', msg: string) => void
): Promise<{ port: number; pid: number }> {
  await stopProjectRuntime(project.id);

  if (!project.start_cmd) {
    throw new Error('No start command configured for dynamic application.');
  }

  const port = await findAvailablePort();
  const cmdStr = project.start_cmd.replace(/\{\{PORT\}\}/g, String(port));
  const { cmd, args } = parseCommandArgs(cmdStr);
  assertSafeExecutable(cmd);

  if (project.framework === 'dockerfile') {
    const caps = await probeHostCapabilities();
    if (!caps.runtimes.docker.daemonRunning) {
      throw new Error(
        'Docker daemon is not running on this host. Configure a Docker host (see docker-compose.yml) to run Dockerfile applications.'
      );
    }
  }

  onLog('info', `Starting isolated process on 127.0.0.1:${port}: ${cmdStr}`);

  const childEnv = createIsolatedChildEnv({
    PORT: String(port),
    HOST: '127.0.0.1',
    HOSTNAME: '127.0.0.1',
    NODE_ENV: 'production',
    NODE_OPTIONS: `--max-old-space-size=${config.appMemoryLimitMb}`,
    PYTHONUNBUFFERED: '1',
  });

  const child = spawn(cmd, args, {
    cwd: projectRootDir,
    env: childEnv,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  activeProcesses.set(project.id, child);

  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) {
        appendBuildLog(project.id, 'stdout', 'runtime', line);
      }
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) {
        appendBuildLog(project.id, 'stderr', 'runtime', line);
      }
    }
  });

  let exitedEarly: string | null = null;
  child.once('exit', (code, signal) => {
    if (activeProcesses.get(project.id) === child) {
      activeProcesses.delete(project.id);
    }
    exitedEarly = `Process exited (code=${code}, signal=${signal})`;
    const latest = getProjectById(project.id);
    if (latest && latest.status === 'live') {
      updateProject(project.id, {
        status: 'stopped',
        pid: null,
        stage_message: `Application process exited (${code ?? signal})`,
      });
    }
  });

  // Poll 127.0.0.1:port until HTTP server accepts connections (up to 25 seconds)
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (exitedEarly) {
      throw new Error(`Application crashed during startup: ${exitedEarly}`);
    }
    const ready = await new Promise<boolean>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/',
          method: 'GET',
          timeout: 1000,
        },
        (res) => {
          res.resume();
          resolve(true);
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
    if (ready) {
      const pid = child.pid ?? 0;
      updateProject(project.id, { internal_port: port, pid });
      onLog('success', `Health check passed on internal port ${port} (PID ${pid}).`);
      return { port, pid };
    }
    await new Promise((r) => setTimeout(r, 350));
  }

  await stopProjectRuntime(project.id);
  throw new Error(
    `Timed out waiting for application to listen on PORT=${port}. Ensure your server binds to process.env.PORT (or os.environ["PORT"]) on 0.0.0.0 or 127.0.0.1.`
  );
}

export async function restoreLiveDeploymentsOnBoot(): Promise<void> {
  const liveProjects = listAllLiveProjects();
  for (const project of liveProjects) {
    const isStatic =
      project.framework === 'static' ||
      project.framework === 'vite' ||
      project.framework === 'react' ||
      (project.framework === 'nextjs' && !project.start_cmd);

    if (isStatic) continue;

    const projectRoot = resolveProjectRootForProject(project);
    if (!fs.existsSync(projectRoot)) {
      updateProject(project.id, { status: 'stopped', stage_message: 'Artifact directory missing' });
      continue;
    }

    try {
      await startDynamicDeployment(project, projectRoot, (level, msg) => {
        appendBuildLog(project.id, level, 'restore', msg);
      });
    } catch (err) {
      updateProject(project.id, {
        status: 'stopped',
        stage_message: `Auto-restore failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

export function resolveProjectRootForProject(project: ProjectRecord): string {
  const workspaceDir = resolveSafePath(config.workspacesDir, project.id);
  return project.root_subpath
    ? resolveSafePath(workspaceDir, project.root_subpath)
    : workspaceDir;
}

export function resolveArtifactDirForProject(project: ProjectRecord): string {
  return resolveSafePath(config.artifactsDir, project.id);
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

function rewriteHtmlForMountPrefix(html: string, mountPrefix: string): string {
  if (!mountPrefix) return html;
  const baseHref = `${mountPrefix}/`;
  let out = html;
  if (!/<base\b/i.test(out)) {
    if (/<head[^>]*>/i.test(out)) {
      out = out.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">`);
    } else {
      out = `<base href="${baseHref}">${out}`;
    }
  }
  // Rewrite root-relative src="/..." and href="/..." (excluding protocol-relative // and already-prefixed /sites/)
  out = out.replace(
    /(\b(?:src|href|action)=["'])\/(?!\/|sites\/)([^"']*["'])/gi,
    `$1${baseHref}$2`
  );
  return out;
}

export async function serveDeployedSiteRequest(
  req: Request,
  res: Response,
  slug: string,
  subPath: string,
  isSubdomainRequest: boolean
): Promise<void> {
  const project = getProjectBySlug(slug);
  if (!project) {
    res.status(404).send(`Site '${slug}' not found.`);
    return;
  }
  if (project.status !== 'live' && project.status !== 'public_blocked') {
    res
      .status(503)
      .send(`Site '${slug}' is currently ${project.status} (${project.stage_message}).`);
    return;
  }

  const mountPrefix = isSubdomainRequest ? '' : `/sites/${slug}`;

  // Dynamic app reverse proxy
  if (project.internal_port && project.start_cmd) {
    await proxyToDynamicProcess(req, res, project, subPath, mountPrefix);
    return;
  }

  // Static artifact serving
  const artifactDir = resolveArtifactDirForProject(project);
  if (!fs.existsSync(artifactDir)) {
    res.status(404).send('Deployed build artifacts are missing.');
    return;
  }

  const cleanSub = subPath.replace(/^\/+/, '').split('?')[0];
  let targetFile = resolveSafePath(artifactDir, cleanSub || 'index.html');

  if (fs.existsSync(targetFile) && fs.statSync(targetFile).isDirectory()) {
    const dirIndex = path.join(targetFile, 'index.html');
    if (fs.existsSync(dirIndex)) {
      targetFile = dirIndex;
    }
  }

  // SPA fallback to index.html if path does not have a file extension
  if (!fs.existsSync(targetFile)) {
    const hasExtension = Boolean(path.extname(cleanSub));
    const fallbackIndex = path.join(artifactDir, 'index.html');
    if (!hasExtension && fs.existsSync(fallbackIndex)) {
      targetFile = fallbackIndex;
    } else {
      res.status(404).send('Not found');
      return;
    }
  }

  const ext = path.extname(targetFile).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);

  if (ext === '.html' || ext === '.htm') {
    const rawHtml = await fsp.readFile(targetFile, 'utf8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(rewriteHtmlForMountPrefix(rawHtml, mountPrefix));
    return;
  }

  fs.createReadStream(targetFile).pipe(res);
}

async function proxyToDynamicProcess(
  req: Request,
  res: Response,
  project: ProjectRecord,
  subPath: string,
  mountPrefix: string
): Promise<void> {
  const queryIdx = req.originalUrl.indexOf('?');
  const queryStr = queryIdx >= 0 ? req.originalUrl.slice(queryIdx) : '';
  const targetPath = (subPath.startsWith('/') ? subPath : `/${subPath}`) + queryStr;

  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!v || k === 'host' || k === 'connection' || k === 'accept-encoding') continue;
    headers[k] = v;
  }
  headers['host'] = `127.0.0.1:${project.internal_port}`;
  if (mountPrefix) {
    headers['x-forwarded-prefix'] = mountPrefix;
  }

  await new Promise<void>((resolve) => {
    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: project.internal_port!,
        path: targetPath,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (!v || k === 'transfer-encoding' || k === 'content-length') continue;
          if (k === 'location' && typeof v === 'string' && mountPrefix && v.startsWith('/')) {
            outHeaders[k] = `${mountPrefix}${v}`;
          } else {
            outHeaders[k] = v;
          }
        }

        const contentType = String(proxyRes.headers['content-type'] || '').toLowerCase();
        if (mountPrefix && contentType.includes('text/html')) {
          const chunks: Buffer[] = [];
          proxyRes.on('data', (c: Buffer) => chunks.push(c));
          proxyRes.on('end', () => {
            const html = Buffer.concat(chunks).toString('utf8');
            res.writeHead(proxyRes.statusCode || 200, outHeaders);
            res.end(rewriteHtmlForMountPrefix(html, mountPrefix));
            resolve();
          });
          return;
        }

        res.writeHead(proxyRes.statusCode || 200, outHeaders);
        proxyRes.pipe(res);
        proxyRes.on('end', resolve);
      }
    );

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.status(502).send(`Upstream application error: ${err.message}`);
      }
      resolve();
    });

    req.pipe(proxyReq);
  });
}
