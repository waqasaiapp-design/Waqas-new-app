import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { config, probeHostCapabilities, resolvePublicHostingConfig } from './config.ts';
import {
  appendBuildLog,
  clearBuildLogs,
  getProjectById,
  getUploadSession,
  updateProject,
  type BuildLogEntry,
  type ProjectRecord,
} from './db.ts';
import {
  assertSafeExecutable,
  buildOwnerPreviewUrl,
  buildPublicLiveUrl,
  parseCommandArgs,
  resolveArtifactDirForProject,
  resolveProjectRootForProject,
  startDynamicDeployment,
  stopProjectRuntime,
} from './deployer.ts';
import { detectProjectFramework, type DetectedProjectConfig } from './detector.ts';
import { extractZipSecurely } from './extractor.ts';
import {
  ensurePublicReadablePermissions,
  explainBlockedPublicDeployment,
  publishToVercelPublicHost,
  verifyPublicLiveWebsite,
} from './publicHosting.ts';
import { createIsolatedChildEnv, resolveSafePath } from './security.ts';
import { materializeUploadToLocalFile } from './storage.ts';

export const buildEvents = new EventEmitter();
buildEvents.setMaxListeners(200);

const runningBuilds = new Set<string>();
const cancelledProjects = new Set<string>();

class ProjectDeletedAbortError extends Error {
  constructor() {
    super('Project deleted while build was in progress.');
  }
}

export function markProjectCancelled(projectId: string): void {
  cancelledProjects.add(projectId);
}

function emitLog(
  projectId: string,
  level: BuildLogEntry['level'],
  stage: string,
  message: string
): void {
  if (cancelledProjects.has(projectId)) return;
  const entry = appendBuildLog(projectId, level, stage, message);
  if (entry) {
    buildEvents.emit(`project:${projectId}`, { type: 'log', log: entry });
  }
}

function emitStatus(project: ProjectRecord): void {
  buildEvents.emit(`project:${project.id}`, { type: 'status', project });
}

export interface BuildOverrides {
  rootSubpath?: string;
  installCmd?: string | null;
  buildCmd?: string | null;
  startCmd?: string | null;
  outputDir?: string | null;
}

class CommandFailureError extends Error {
  command: string;
  exitCode: number | null;
  firstRootError: string | null;
  capturedLines: string[];

  constructor(
    command: string,
    exitCode: number | null,
    firstRootError: string | null,
    capturedLines: string[]
  ) {
    const detail = firstRootError
      ? `${firstRootError} (command: '${command}', exit code ${exitCode ?? 'unknown'})`
      : `Command '${command}' exited with status code ${exitCode ?? 'unknown'}.`;
    super(detail);
    this.command = command;
    this.exitCode = exitCode;
    this.firstRootError = firstRootError;
    this.capturedLines = capturedLines;
  }
}

export function enqueueBuildJob(
  projectId: string,
  reqOrigin?: { host?: string; proto?: string },
  overrides?: BuildOverrides
): void {
  if (runningBuilds.has(projectId)) return;
  runningBuilds.add(projectId);

  setImmediate(async () => {
    try {
      await runBuildPipeline(projectId, reqOrigin, overrides);
    } finally {
      runningBuilds.delete(projectId);
    }
  });
}

async function runBuildPipeline(
  projectId: string,
  _reqOrigin?: { host?: string; proto?: string },
  overrides?: BuildOverrides
): Promise<void> {
  if (cancelledProjects.has(projectId)) {
    cancelledProjects.delete(projectId);
    return;
  }
  const startedAt = Date.now();
  let project = getProjectById(projectId);
  if (!project) return;

  const setStage = (
    status: ProjectRecord['status'],
    stageMessage: string,
    extra: Partial<ProjectRecord> = {}
  ) => {
    if (cancelledProjects.has(projectId)) {
      throw new ProjectDeletedAbortError();
    }
    updateProject(projectId, { status, stage_message: stageMessage, ...extra });
    const latest = getProjectById(projectId);
    if (!latest) {
      throw new ProjectDeletedAbortError();
    }
    project = latest;
    emitStatus(project);
  };

  let tempZipToDelete: string | null = null;

  try {
    clearBuildLogs(projectId);
    await stopProjectRuntime(projectId);

    // 1. EXTRACT
    setStage('extracting', 'Extracting ZIP archive securely...', {
      error_message: null,
      error_hint: null,
      live_url: null,
      preview_url: null,
      public_verification: null,
    });
    emitLog(projectId, 'info', 'extract', `Preparing archive for ${project.name}...`);

    const upload = getUploadSession(project.source_upload_id);
    if (!upload || upload.status !== 'completed') {
      throw new Error('Source ZIP upload is missing or incomplete.');
    }

    const { zipPath, cleanupAfterExtract } = await materializeUploadToLocalFile(upload);
    if (cleanupAfterExtract) tempZipToDelete = zipPath;

    const workspaceDir = resolveSafePath(config.workspacesDir, project.id);
    const extractResult = await extractZipSecurely(zipPath, workspaceDir, (msg) => {
      emitLog(projectId, 'info', 'extract', msg);
    });

    if (tempZipToDelete) {
      await fsp.rm(tempZipToDelete, { force: true }).catch(() => {});
      tempZipToDelete = null;
    }

    if (cancelledProjects.has(projectId) || !getProjectById(projectId)) {
      throw new ProjectDeletedAbortError();
    }

    const effectiveSubpath = overrides?.rootSubpath ?? extractResult.rootSubpath;
    const projectRootDir = effectiveSubpath
      ? resolveSafePath(workspaceDir, effectiveSubpath)
      : extractResult.projectRootDir;

    updateProject(projectId, {
      root_subpath: effectiveSubpath,
      file_count: extractResult.fileCount,
      extracted_bytes: extractResult.extractedBytes,
    });
    emitLog(
      projectId,
      'success',
      'extract',
      `Extracted ${extractResult.fileCount} files (${(extractResult.extractedBytes / (1024 * 1024)).toFixed(2)} MB). Root: ${effectiveSubpath || '/'}`
    );

    // 2. DETECT PROJECT
    setStage('detecting', 'Detecting framework, lockfile, and package manager...');
    const detected = await detectProjectFramework(projectRootDir, project.slug);
    const caps = await probeHostCapabilities();
    const hosting = resolvePublicHostingConfig();

    let installCmd = overrides?.installCmd !== undefined ? overrides.installCmd : detected.installCmd;
    const buildCmd = overrides?.buildCmd !== undefined ? overrides.buildCmd : detected.buildCmd;
    const startCmd = overrides?.startCmd !== undefined ? overrides.startCmd : detected.startCmd;
    const outputDir = overrides?.outputDir !== undefined ? overrides.outputDir : detected.outputDir;

    if (installCmd?.startsWith('pnpm') && !caps.runtimes.pnpm.available) {
      emitLog(
        projectId,
        'info',
        'detect',
        'pnpm binary not installed in host runtime; falling back to npm install --no-audit --no-fund.'
      );
      installCmd = 'npm install --no-audit --no-fund';
    } else if (installCmd?.startsWith('yarn') && !caps.runtimes.yarn.available) {
      emitLog(
        projectId,
        'info',
        'detect',
        'yarn binary not installed in host runtime; falling back to npm install --no-audit --no-fund.'
      );
      installCmd = 'npm install --no-audit --no-fund';
    } else if (installCmd?.startsWith('bun') && !caps.runtimes.bun.available) {
      emitLog(
        projectId,
        'info',
        'detect',
        'bun binary not installed in host runtime; falling back to npm install --no-audit --no-fund.'
      );
      installCmd = 'npm install --no-audit --no-fund';
    }

    updateProject(projectId, {
      framework: detected.framework,
      install_cmd: installCmd,
      build_cmd: buildCmd,
      start_cmd: startCmd,
      output_dir: outputDir,
      hosting_provider: hosting.provider,
    });

    emitLog(projectId, 'info', 'detect', `${detected.reason} Framework: ${detected.framework}`);
    emitLog(
      projectId,
      'info',
      'detect',
      `Host runtime: Node ${caps.runtimes.node.version || 'unknown'}, Free RAM ${Math.round(caps.memoryFreeBytes / (1024 * 1024))} MB, Free Disk ${(caps.diskAvailableBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
    );
    emitLog(
      projectId,
      'info',
      'detect',
      `Public hosting mode: ${hosting.provider}${hosting.origin ? ` (${hosting.origin})` : ' (unconfigured / private preview only)'}`
    );

    if (detected.framework === 'dockerfile' && !caps.runtimes.docker.daemonRunning) {
      throw new Error(
        'Dockerfile detected, but no Docker daemon is running on this host environment.'
      );
    }

    // 3. INSTALL DEPENDENCIES
    if (installCmd) {
      if (detected.framework === 'python' && !caps.runtimes.pip.available) {
        const reqPath = path.join(projectRootDir, 'requirements.txt');
        const reqText = await fsp.readFile(reqPath, 'utf8').catch(() => '');
        const nonEmptyLines = reqText
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'));
        if (nonEmptyLines.length > 0) {
          throw new Error(
            `Python requirements.txt specifies ${nonEmptyLines.join(', ')}, but python3-pip is not installed in this container runtime.`
          );
        }
      } else {
        setStage('installing', `Installing dependencies (${detected.packageManager || 'runtime'})...`);
        await installWithAutoRecovery(projectId, installCmd, projectRootDir, detected);
      }
    }

    // 4. BUILD PROJECT
    const isRootDomainProvider =
      hosting.provider === 'wildcard-domain' || hosting.provider === 'vercel';

    if (buildCmd) {
      setStage('building', 'Running project build...');
      let actualBuildCmd = buildCmd;
      if (
        (actualBuildCmd.startsWith('pnpm ') && !caps.runtimes.pnpm.available) ||
        (actualBuildCmd.startsWith('yarn ') && !caps.runtimes.yarn.available) ||
        (actualBuildCmd.startsWith('bun ') && !caps.runtimes.bun.available)
      ) {
        actualBuildCmd = actualBuildCmd.replace(/^(pnpm|yarn|bun)\s+(run\s+)?/, 'npm run ');
      }

      const mountBase = isRootDomainProvider ? '/' : `/sites/${project.slug}/`;
      if (detected.framework === 'vite' && actualBuildCmd === 'npm run build') {
        const pkgJson = JSON.parse(
          await fsp.readFile(path.join(projectRootDir, 'package.json'), 'utf8')
        ) as { scripts?: Record<string, string> };
        if (pkgJson.scripts?.build?.trim() === 'vite build') {
          actualBuildCmd = `npm run build -- --base=${mountBase}`;
        }
      } else if (detected.framework === 'vite' && actualBuildCmd === 'npx vite build') {
        actualBuildCmd = `npx vite build --base=${mountBase}`;
      }

      const extraBuildEnv: Record<string, string> = {};
      if (detected.framework === 'react') {
        extraBuildEnv.PUBLIC_URL = isRootDomainProvider ? '/' : `/sites/${project.slug}`;
      }

      await buildWithAutoRecovery(
        projectId,
        actualBuildCmd,
        projectRootDir,
        extraBuildEnv,
        detected
      );
    }

    // 5. DEPLOY & VERIFY REAL PUBLIC ACCESS (NO 403 / NO PRIVATE PREVIEW LINKS)
    setStage('deploying', 'Deploying website and verifying external public HTTPS access...');
    const isStatic =
      detected.framework === 'static' ||
      detected.framework === 'vite' ||
      detected.framework === 'react' ||
      (detected.framework === 'nextjs' && !startCmd);

    const previewPath = buildOwnerPreviewUrl(project.slug);
    const artifactDir = resolveArtifactDirForProject(project);

    if (isStatic) {
      const resolvedOutDir = await resolveStaticBuildOutput(projectRootDir, outputDir);
      await fsp.rm(artifactDir, { recursive: true, force: true });
      await fsp.cp(resolvedOutDir, artifactDir, { recursive: true });
      await ensurePublicReadablePermissions(artifactDir);
      emitLog(
        projectId,
        'info',
        'deploy',
        `Published static build output from '${path.relative(projectRootDir, resolvedOutDir) || '.'}' with world-readable POSIX permissions (0755/0644).`
      );
    } else {
      let actualStartCmd = startCmd;
      if (
        actualStartCmd &&
        ((actualStartCmd.startsWith('pnpm ') && !caps.runtimes.pnpm.available) ||
          (actualStartCmd.startsWith('yarn ') && !caps.runtimes.yarn.available) ||
          (actualStartCmd.startsWith('bun ') && !caps.runtimes.bun.available))
      ) {
        actualStartCmd = actualStartCmd.replace(/^(pnpm|yarn|bun)\s+(run\s+)?/, 'npm run ');
      }
      if (actualStartCmd && actualStartCmd !== project.start_cmd) {
        updateProject(projectId, { start_cmd: actualStartCmd });
      }
      await startDynamicDeployment(getProjectById(projectId)!, projectRootDir, (level, msg) => {
        emitLog(projectId, level, 'deploy', msg);
      });
    }

    // Allow local internal preview route while running public verification
    updateProject(projectId, {
      status: 'public_blocked',
      preview_url: previewPath,
      hosting_provider: hosting.provider,
    });

    // Verify internal loopback routing + assets first so we know the built site itself is healthy
    const localSmoke = await verifyLocalSiteSmoke(project.slug);
    if (!localSmoke.ok) {
      await stopProjectRuntime(projectId);
      throw new Error(
        `Built site failed internal health smoke check at ${previewPath}: ${localSmoke.error || `HTTP ${localSmoke.status}`}`
      );
    }
    emitLog(
      projectId,
      'success',
      'verify',
      `Internal runtime smoke check passed (${previewPath} -> HTTP ${localSmoke.status}).`
    );

    // Publish to configured real public hosting provider or run strict external public verification
    const { finalStatus, liveUrl, verification, providerUsed, errorMessage, errorHint } =
      await publishAndVerifyPublicEndpoint({
        projectId,
        slug: project.slug,
        framework: detected.framework,
        isStatic,
        artifactDir,
        projectRootDir,
        previewPath,
      });

    const durationMs = Date.now() - startedAt;

    if (finalStatus === 'live' && liveUrl) {
      setStage('live', 'Website is live and externally verified without authentication', {
        live_url: liveUrl,
        preview_url: previewPath,
        hosting_provider: providerUsed,
        public_verification: verification,
        error_message: null,
        error_hint: null,
        build_duration_ms: durationMs,
        last_deployed_at: Date.now(),
      });
      emitLog(
        projectId,
        'success',
        'deploy',
        `Verified public HTTPS URL (HTTP ${verification.httpStatus}, ${verification.assetsChecked} assets OK, zero auth/403): ${liveUrl} (${(durationMs / 1000).toFixed(1)}s)`
      );
    } else {
      setStage('public_blocked', 'Build succeeded, but external public URL returned 403 / auth gate', {
        live_url: null,
        preview_url: previewPath,
        hosting_provider: providerUsed,
        public_verification: verification,
        error_message: errorMessage,
        error_hint: errorHint,
        build_duration_ms: durationMs,
        last_deployed_at: Date.now(),
      });
      emitLog(projectId, 'error', 'verify', errorMessage || 'Public URL verification failed.');
      if (errorHint) {
        emitLog(projectId, 'info', 'hint', `How to enable public URLs: ${errorHint}`);
      }
    }
  } catch (err) {
    if (
      err instanceof ProjectDeletedAbortError ||
      cancelledProjects.has(projectId) ||
      !getProjectById(projectId)
    ) {
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const hint = diagnoseBuildError(message);
    emitLog(projectId, 'error', 'error', message);
    if (hint) {
      emitLog(projectId, 'info', 'hint', `Suggested fix: ${hint}`);
    }
    if (getProjectById(projectId)) {
      updateProject(projectId, {
        status: 'failed',
        stage_message: 'Build or deployment failed',
        error_message: message,
        error_hint: hint,
        live_url: null,
        build_duration_ms: Date.now() - startedAt,
      });
      const updated = getProjectById(projectId);
      if (updated) emitStatus(updated);
    }
  } finally {
    cancelledProjects.delete(projectId);
    if (tempZipToDelete) {
      await fsp.rm(tempZipToDelete, { force: true }).catch(() => {});
    }
  }
}

export async function verifyAndPublishExistingProject(
  projectId: string
): Promise<ProjectRecord | null> {
  const project = getProjectById(projectId);
  if (!project) return null;

  const isStatic =
    project.framework === 'static' ||
    project.framework === 'vite' ||
    project.framework === 'react' ||
    (project.framework === 'nextjs' && !project.start_cmd);
  const artifactDir = resolveArtifactDirForProject(project);
  const projectRootDir = resolveProjectRootForProject(project);
  const previewPath = buildOwnerPreviewUrl(project.slug);

  if (isStatic && fs.existsSync(artifactDir)) {
    await ensurePublicReadablePermissions(artifactDir);
  } else if (!isStatic && !project.internal_port) {
    await startDynamicDeployment(project, projectRootDir, (level, msg) => {
      emitLog(project.id, level, 'deploy', msg);
    });
  }

  const res = await publishAndVerifyPublicEndpoint({
    projectId: project.id,
    slug: project.slug,
    framework: project.framework,
    isStatic,
    artifactDir,
    projectRootDir,
    previewPath,
  });

  if (res.finalStatus === 'live' && res.liveUrl) {
    updateProject(project.id, {
      status: 'live',
      stage_message: 'Website is live and externally verified without authentication',
      live_url: res.liveUrl,
      preview_url: previewPath,
      hosting_provider: res.providerUsed,
      public_verification: res.verification,
      error_message: null,
      error_hint: null,
      last_deployed_at: Date.now(),
    });
    emitLog(
      project.id,
      'success',
      'verify',
      `Re-verified public HTTPS URL (HTTP ${res.verification.httpStatus}): ${res.liveUrl}`
    );
  } else {
    updateProject(project.id, {
      status: 'public_blocked',
      stage_message: 'Build ready, but public URL is blocked (403 / missing public host)',
      live_url: null,
      preview_url: previewPath,
      hosting_provider: res.providerUsed,
      public_verification: res.verification,
      error_message: res.errorMessage,
      error_hint: res.errorHint,
    });
    emitLog(
      project.id,
      'error',
      'verify',
      res.errorMessage || 'Public verification failed.'
    );
  }

  const latest = getProjectById(project.id);
  if (latest) emitStatus(latest);
  return latest;
}

async function publishAndVerifyPublicEndpoint(params: {
  projectId: string;
  slug: string;
  framework: ProjectRecord['framework'];
  isStatic: boolean;
  artifactDir: string;
  projectRootDir: string;
  previewPath: string;
}): Promise<{
  finalStatus: 'live' | 'public_blocked';
  liveUrl: string | null;
  providerUsed: string;
  verification: Awaited<ReturnType<typeof verifyPublicLiveWebsite>>;
  errorMessage: string | null;
  errorHint: string | null;
}> {
  const { projectId, slug, framework, isStatic, artifactDir, projectRootDir, previewPath } = params;
  const hosting = resolvePublicHostingConfig();

  let candidateUrl: string | null = null;
  let providerUsed: string = hosting.provider;

  if (hosting.provider === 'vercel') {
    const canDeployToVercel = isStatic || framework === 'nextjs';
    if (canDeployToVercel) {
      const published = await publishToVercelPublicHost({
        slug,
        framework,
        isStatic,
        artifactDir,
        projectRootDir,
        onLog: (level, msg) => emitLog(projectId, level, 'deploy', msg),
      });
      candidateUrl = published.url;
      providerUsed = published.provider;
    } else {
      // Persistent Node.js / Python / Dockerfile servers require a container/VPS runtime
      candidateUrl = buildPublicLiveUrl(slug);
      if (!candidateUrl) {
        const msg =
          `Server-side ${framework} application built cleanly, but requires a public container runtime (PUBLIC_BASE_DOMAIN or PUBLIC_HOSTING_URL on Cloud Run / Docker) because long-running ${framework} socket servers cannot run on Vercel static/serverless CDN.`;
        const verification = await verifyPublicLiveWebsite(
          config.appUrl ? `${config.appUrl}${previewPath}` : `http://127.0.0.1:${config.port}${previewPath}`
        );
        return {
          finalStatus: 'public_blocked',
          liveUrl: null,
          providerUsed: 'private-preview',
          verification,
          errorMessage: msg,
          errorHint:
            'Open Public Hosting Setup and deploy WAQAS ZIP TO WEB on an unauthenticated Cloud Run service or Docker VPS with PUBLIC_BASE_DOMAIN or PUBLIC_HOSTING_URL configured.',
        };
      }
    }
  } else if (hosting.ready) {
    candidateUrl = buildPublicLiveUrl(slug);
  }

  // If no public host is configured, probe the active APP_URL/localhost strictly to prove the 403/auth block honestly
  const urlToProbe =
    candidateUrl ||
    (config.appUrl ? `${config.appUrl}${previewPath}` : `http://127.0.0.1:${config.port}${previewPath}`);

  emitLog(projectId, 'info', 'verify', `Running unauthenticated external verification on: ${urlToProbe}`);
  const verification = await verifyPublicLiveWebsite(urlToProbe);

  if (verification.ok && candidateUrl) {
    return {
      finalStatus: 'live',
      liveUrl: verification.finalUrl || candidateUrl,
      providerUsed,
      verification,
      errorMessage: null,
      errorHint: null,
    };
  }

  const explained = explainBlockedPublicDeployment({
    slug,
    previewPath,
    verification,
  });

  return {
    finalStatus: 'public_blocked',
    liveUrl: null,
    providerUsed,
    verification,
    errorMessage: explained.errorMessage,
    errorHint: explained.hint,
  };
}

async function verifyLocalSiteSmoke(
  slug: string
): Promise<{ ok: boolean; status?: number; error?: string }> {
  for (let i = 0; i < 6; i++) {
    const res = await probeLocalHttp(`/sites/${slug}/`, 0);
    if (res.ok) return res;
    if (i < 5) await new Promise((r) => setTimeout(r, 400));
    else return res;
  }
  return { ok: false, error: 'Verification timed out' };
}

async function probeLocalHttp(
  urlPath: string,
  redirectsLeft: number
): Promise<{ ok: boolean; status?: number; error?: string }> {
  return await new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: config.port,
        path: urlPath,
        method: 'GET',
        timeout: 3000,
      },
      (res) => {
        res.resume();
        const code = res.statusCode || 500;
        if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
          const nextPath = res.headers.location.startsWith('http')
            ? new URL(res.headers.location).pathname + new URL(res.headers.location).search
            : res.headers.location;
          probeLocalHttp(nextPath, redirectsLeft - 1).then(resolve);
          return;
        }
        resolve({ ok: code >= 200 && code < 400, status: code });
      }
    );
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'HTTP probe timeout' });
    });
    req.end();
  });
}

async function backupAndCleanNodeModules(projectId: string, projectRootDir: string): Promise<void> {
  const nmPath = path.join(projectRootDir, 'node_modules');
  if (!fs.existsSync(nmPath)) return;
  const backupRoot = path.join(projectRootDir, '.waqas-backup');
  await fsp.mkdir(backupRoot, { recursive: true });
  const backupTarget = path.join(backupRoot, `node_modules.${Date.now()}`);
  await fsp.rename(nmPath, backupTarget);
  emitLog(
    projectId,
    'info',
    'recover',
    `Preserved original node_modules backup at .waqas-backup/${path.basename(backupTarget)} before clean install.`
  );
}

async function installWithAutoRecovery(
  projectId: string,
  primaryCmd: string,
  projectRootDir: string,
  detected: DetectedProjectConfig
): Promise<void> {
  const pmEnv: Record<string, string> = {
    npm_config_cache: config.npmCacheDir,
    npm_config_prefer_offline: 'false',
    npm_config_fetch_retries: '4',
    npm_config_fetch_retry_mintimeout: '2000',
    npm_config_update_notifier: 'false',
  };

  if (detected.hasPrepackagedNodeModules) {
    const lockMarker = path.join(projectRootDir, 'node_modules', '.package-lock.json');
    if (!fs.existsSync(lockMarker)) {
      emitLog(
        projectId,
        'info',
        'install',
        'Notice: ZIP included an existing node_modules directory. Will back it up and run a clean Linux install if incompatibilities occur.'
      );
    }
  }

  try {
    await runIsolatedCommand(projectId, 'install', primaryCmd, projectRootDir, pmEnv);
    return;
  } catch (err) {
    if (!(err instanceof CommandFailureError)) throw err;
    const rawText = [err.firstRootError || '', ...err.capturedLines].join('\n').toLowerCase();

    if (
      primaryCmd.startsWith('npm ci') &&
      (rawText.includes('eusage') ||
        rawText.includes('in sync') ||
        rawText.includes('npm ci can only install'))
    ) {
      emitLog(
        projectId,
        'info',
        'recover',
        'package-lock.json is out of sync with package.json. Recovering with npm install --no-audit --no-fund...'
      );
      try {
        await runIsolatedCommand(
          projectId,
          'install',
          'npm install --no-audit --no-fund',
          projectRootDir,
          pmEnv
        );
        return;
      } catch (retryErr) {
        if (!(retryErr instanceof CommandFailureError)) throw retryErr;
        const retryText = [retryErr.firstRootError || '', ...retryErr.capturedLines]
          .join('\n')
          .toLowerCase();
        if (
          retryText.includes('eresolve') ||
          retryText.includes('could not resolve') ||
          retryText.includes('peer dependency')
        ) {
          emitLog(
            projectId,
            'info',
            'recover',
            'Peer dependency conflict detected. Retrying with --legacy-peer-deps...'
          );
          await runIsolatedCommand(
            projectId,
            'install',
            'npm install --legacy-peer-deps --no-audit --no-fund',
            projectRootDir,
            pmEnv
          );
          return;
        }
        throw retryErr;
      }
    }

    if (
      rawText.includes('eresolve') ||
      rawText.includes('unable to resolve dependency tree') ||
      rawText.includes('conflicting peer dependency') ||
      rawText.includes('could not resolve')
    ) {
      emitLog(
        projectId,
        'info',
        'recover',
        'Peer dependency conflict detected (ERESOLVE). Retrying with npm install --legacy-peer-deps...'
      );
      await runIsolatedCommand(
        projectId,
        'install',
        'npm install --legacy-peer-deps --no-audit --no-fund',
        projectRootDir,
        pmEnv
      );
      return;
    }

    if (primaryCmd.startsWith('pnpm')) {
      emitLog(projectId, 'info', 'recover', 'Retrying pnpm install with --no-frozen-lockfile...');
      try {
        await runIsolatedCommand(
          projectId,
          'install',
          'pnpm install --no-frozen-lockfile',
          projectRootDir,
          pmEnv
        );
        return;
      } catch {
        emitLog(
          projectId,
          'info',
          'recover',
          'pnpm recovery failed; falling back to npm install --legacy-peer-deps...'
        );
        await runIsolatedCommand(
          projectId,
          'install',
          'npm install --legacy-peer-deps --no-audit --no-fund',
          projectRootDir,
          pmEnv
        );
        return;
      }
    }

    if (primaryCmd.startsWith('yarn')) {
      emitLog(projectId, 'info', 'recover', 'Retrying yarn install with --ignore-engines...');
      try {
        await runIsolatedCommand(
          projectId,
          'install',
          'yarn install --ignore-engines',
          projectRootDir,
          pmEnv
        );
        return;
      } catch {
        emitLog(
          projectId,
          'info',
          'recover',
          'yarn recovery failed; falling back to npm install --legacy-peer-deps...'
        );
        await runIsolatedCommand(
          projectId,
          'install',
          'npm install --legacy-peer-deps --no-audit --no-fund',
          projectRootDir,
          pmEnv
        );
        return;
      }
    }

    if (primaryCmd.startsWith('bun')) {
      if (primaryCmd.includes('--frozen-lockfile')) {
        emitLog(projectId, 'info', 'recover', 'Retrying bun install without --frozen-lockfile...');
        try {
          await runIsolatedCommand(projectId, 'install', 'bun install', projectRootDir, pmEnv);
          return;
        } catch {
          // Fall through
        }
      }
      emitLog(
        projectId,
        'info',
        'recover',
        'Bun install failed; falling back to npm install --legacy-peer-deps...'
      );
      await runIsolatedCommand(
        projectId,
        'install',
        'npm install --legacy-peer-deps --no-audit --no-fund',
        projectRootDir,
        pmEnv
      );
      return;
    }

    if (
      detected.hasPrepackagedNodeModules &&
      (rawText.includes('enotempty') ||
        rawText.includes('eexist') ||
        rawText.includes('ebadplatform') ||
        rawText.includes('eacces') ||
        rawText.includes('cannot find module'))
    ) {
      await backupAndCleanNodeModules(projectId, projectRootDir);
      await runIsolatedCommand(
        projectId,
        'install',
        'npm install --legacy-peer-deps --no-audit --no-fund',
        projectRootDir,
        pmEnv
      );
      return;
    }

    if (
      rawText.includes('etimedout') ||
      rawText.includes('econnreset') ||
      rawText.includes('eai_again') ||
      rawText.includes('socket hang up') ||
      rawText.includes('network') ||
      rawText.includes(' 502 ') ||
      rawText.includes(' 503 ') ||
      rawText.includes(' 504 ')
    ) {
      emitLog(
        projectId,
        'info',
        'recover',
        'Transient registry/network error detected. Waiting 2s and retrying dependency install...'
      );
      await new Promise((r) => setTimeout(r, 2000));
      await runIsolatedCommand(projectId, 'install', primaryCmd, projectRootDir, pmEnv);
      return;
    }

    throw err;
  }
}

async function buildWithAutoRecovery(
  projectId: string,
  buildCmd: string,
  projectRootDir: string,
  extraBuildEnv: Record<string, string>,
  detected: DetectedProjectConfig
): Promise<void> {
  try {
    await runIsolatedCommand(projectId, 'build', buildCmd, projectRootDir, extraBuildEnv);
    return;
  } catch (err) {
    if (!(err instanceof CommandFailureError)) throw err;
    const rawText = [err.firstRootError || '', ...err.capturedLines].join('\n').toLowerCase();

    if (
      detected.hasPrepackagedNodeModules &&
      (rawText.includes('you installed esbuild for another platform') ||
        rawText.includes('invalid elf header') ||
        rawText.includes('cannot find package') ||
        rawText.includes('exec format error'))
    ) {
      emitLog(
        projectId,
        'info',
        'recover',
        'Detected incompatible OS binaries in uploaded node_modules. Backing up and reinstalling Linux packages...'
      );
      await backupAndCleanNodeModules(projectId, projectRootDir);
      await installWithAutoRecovery(
        projectId,
        'npm install --legacy-peer-deps --no-audit --no-fund',
        projectRootDir,
        { ...detected, hasPrepackagedNodeModules: false }
      );
      await runIsolatedCommand(projectId, 'build', buildCmd, projectRootDir, extraBuildEnv);
      return;
    }

    if (
      rawText.includes('heap out of memory') ||
      rawText.includes('allocation failed - javascript heap')
    ) {
      const freeMb = Math.floor(os.freemem() / (1024 * 1024));
      const bumpedHeap = Math.max(1024, Math.min(3072, Math.floor(freeMb * 0.75)));
      emitLog(
        projectId,
        'info',
        'recover',
        `Build ran out of JS heap memory. Retrying with --max-old-space-size=${bumpedHeap}...`
      );
      await runIsolatedCommand(projectId, 'build', buildCmd, projectRootDir, {
        ...extraBuildEnv,
        NODE_OPTIONS: `--max-old-space-size=${bumpedHeap}`,
      });
      return;
    }

    throw err;
  }
}

async function resolveStaticBuildOutput(
  projectRootDir: string,
  preferredDir: string | null
): Promise<string> {
  const candidates = [preferredDir, 'dist', 'build', 'out', 'public', '.'].filter(
    (c): c is string => Boolean(c)
  );
  for (const rel of candidates) {
    const abs = resolveSafePath(projectRootDir, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      if (rel === '.' || fs.existsSync(path.join(abs, 'index.html'))) {
        return abs;
      }
    }
  }
  throw new Error(
    `Build completed, but no output directory with index.html was found (checked: ${candidates.join(', ')}).`
  );
}

function extractFirstRootError(lines: string[]): string | null {
  const cleaned = lines.map((l) => l.trim()).filter(Boolean);
  const priorityPatterns = [
    /npm\s+(?:error|ERR!)\s+code\s+\S+.*/i,
    /npm\s+(?:error|ERR!)\s+(?:ERESOLVE|E404|ENOENT|EACCES|ETIMEDOUT|EUSAGE).*/i,
    /(?:ERR_PNPM_|YN\d{4}:|error:|Error:|SyntaxError:|TypeError:|ReferenceError:).+/,
    /Could not resolve dependency.*/i,
    /404 Not Found\s*-\s*.*/i,
    /No matching version found.*/i,
    /Unsupported engine.*/i,
    /ENOSPC.*/i,
    /JavaScript heap out of memory.*/i,
  ];
  for (const pattern of priorityPatterns) {
    for (const line of cleaned) {
      if (pattern.test(line)) {
        return line.replace(/^npm\s+(?:error|ERR!)\s+/i, '').slice(0, 320);
      }
    }
  }
  const fallback = cleaned.find(
    (l) =>
      !/^npm\s+(?:error|ERR!)\s+A complete log of this run/i.test(l) &&
      (l.toLowerCase().includes('error') || l.toLowerCase().includes('failed'))
  );
  return fallback ? fallback.slice(0, 320) : null;
}

async function runIsolatedCommand(
  projectId: string,
  stage: string,
  commandStr: string,
  cwd: string,
  extraEnv: Record<string, string> = {}
): Promise<void> {
  const { cmd, args } = parseCommandArgs(commandStr);
  assertSafeExecutable(cmd);
  emitLog(projectId, 'info', stage, `$ ${commandStr}`);

  const freeMb = Math.floor(os.freemem() / (1024 * 1024));
  const defaultHeapMb = Math.max(512, Math.min(2048, Math.floor(freeMb * 0.6)));
  const childEnv = createIsolatedChildEnv({
    NODE_OPTIONS: `--max-old-space-size=${defaultHeapMb}`,
    ...extraEnv,
  });

  const capturedLines: string[] = [];
  const pushCaptured = (line: string) => {
    capturedLines.push(line);
    if (capturedLines.length > 400) capturedLines.shift();
  };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: childEnv,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      try {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1500);
      } catch {
        // ignore
      }
      reject(
        new Error(
          `Command '${commandStr}' exceeded build timeout (${config.buildTimeoutMs / 1000}s).`
        )
      );
    }, config.buildTimeoutMs);

    const handleLines = (level: 'stdout' | 'stderr') => {
      let buffer = '';
      return (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) {
            pushCaptured(line);
            emitLog(projectId, level, stage, line);
          }
        }
      };
    };

    const flushStdout = handleLines('stdout');
    const flushStderr = handleLines('stderr');
    child.stdout?.on('data', flushStdout);
    child.stderr?.on('data', flushStderr);

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to execute '${cmd}': ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        emitLog(projectId, 'success', stage, `${stage} step completed cleanly.`);
        resolve();
      } else {
        const firstRootError = extractFirstRootError(capturedLines);
        reject(new CommandFailureError(commandStr, code, firstRootError, capturedLines));
      }
    });
  });
}

function diagnoseBuildError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('eresolve') || lower.includes('peer dependency')) {
    return 'A dependency peer-version conflict occurred. Retry Build with `npm install --legacy-peer-deps` or align package versions in package.json.';
  }
  if (lower.includes('e404') || lower.includes('404 not found') || lower.includes('not in this registry')) {
    return 'A package listed in package.json does not exist or is private on the npm registry. Check the package name and version.';
  }
  if (lower.includes('enospc')) {
    return 'Host disk space ran out during install/build. Remove old deployments or large assets like node_modules from your ZIP.';
  }
  if (lower.includes('heap out of memory')) {
    return 'The bundler exceeded available RAM. Exclude unneeded assets or upgrade host memory.';
  }
  if (lower.includes('docker daemon is not running')) {
    return 'Run WAQAS ZIP TO WEB with the included docker-compose.yml on a Linux/Docker VPS to build and host Dockerfile projects.';
  }
  if (lower.includes('python3-pip is not installed')) {
    return 'Use Python standard-library web servers (http.server) in this container, or host on a server with pip/Docker enabled for third-party packages.';
  }
  if (lower.includes('enoent') || lower.includes('cannot find module')) {
    return 'Verify all imported files and dependencies are listed in package.json and included inside the ZIP archive.';
  }
  if (lower.includes('path traversal') || lower.includes('symlink')) {
    return 'Repackage the ZIP cleanly without symlinks or parent directory (..) references.';
  }
  if (lower.includes('zip bomb') || lower.includes('uncompressed archive size')) {
    return 'Remove build artifacts like node_modules or .git before zipping so the archive stays clean and lightweight.';
  }
  if (lower.includes('port=')) {
    return 'Ensure your Node.js or Python server reads process.env.PORT (or os.environ["PORT"]) and listens on 0.0.0.0 or 127.0.0.1.';
  }
  if (lower.includes('no output directory')) {
    return 'Click Retry Build and specify the exact build output folder (e.g., dist, build, or out).';
  }
  return 'Inspect the build log above, verify your project builds locally, or adjust the build/start command and click Retry Build.';
}
