import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, ensureDataDirectories, probeHostCapabilities } from './server/config.ts';
import {
  appendBuildLog,
  countProjectsByUploadId,
  createProject,
  deleteProjectRecord,
  deleteUploadRecord,
  getBuildLogs,
  getProjectById,
  getUploadSession,
  listProjectsByOwner,
  updateProject,
  updateUploadSession,
  type ProjectRecord,
} from './server/db.ts';
import {
  buildEvents,
  enqueueBuildJob,
  markProjectCancelled,
  verifyAndPublishExistingProject,
  type BuildOverrides,
} from './server/builder.ts';
import {
  buildOwnerPreviewUrl,
  resolveArtifactDirForProject,
  resolveProjectRootForProject,
  restoreLiveDeploymentsOnBoot,
  serveDeployedSiteRequest,
  startDynamicDeployment,
  stopProjectRuntime,
} from './server/deployer.ts';
import {
  generateId,
  resolveSafePath,
  resolveWorkspaceToken,
  sanitizeSlug,
} from './server/security.ts';
import { streamSourceCodeZip } from './server/sourceExporter.ts';
import {
  cancelOrDeleteUpload,
  cleanupAbandonedUploads,
  closeWriteHandle,
  finalizeUpload,
  getPresignedPartBatch,
  getPresignedPartUrl,
  initMultipartUpload,
  registerS3UploadedPart,
  writeLocalChunk,
} from './server/storage.ts';

async function startServer() {
  ensureDataDirectories();
  const app = express();
  app.set('trust proxy', true);

  // 1. Subdomain public site routing (<slug>.<PUBLIC_BASE_DOMAIN>/*)
  if (config.publicBaseDomain) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const host = (req.hostname || '').toLowerCase();
      const suffix = `.${config.publicBaseDomain}`;
      if (host.endsWith(suffix) && host.length > suffix.length) {
        const slug = host.slice(0, host.length - suffix.length);
        if (/^[a-z0-9-]+$/.test(slug)) {
          serveDeployedSiteRequest(req, res, slug, req.path, true).catch(next);
          return;
        }
      }
      next();
    });
  }

  // 2. Public deployed website path routing (/sites/:slug/*)
  app.use('/sites/:slug', (req: Request, res: Response, next: NextFunction) => {
    const slug = String(req.params.slug || '');
    if (!/^[a-z0-9-]+$/.test(slug)) {
      res.status(400).send('Invalid site slug.');
      return;
    }
    if (req.originalUrl === `/sites/${slug}` || req.originalUrl.startsWith(`/sites/${slug}?`)) {
      const qIdx = req.originalUrl.indexOf('?');
      const qs = qIdx >= 0 ? req.originalUrl.slice(qIdx) : '';
      res.redirect(301, `/sites/${slug}/${qs}`);
      return;
    }
    serveDeployedSiteRequest(req, res, slug, req.path || '/', false).catch(next);
  });

  // 3. API Routes
  const jsonParser = express.json({ limit: '2mb' });
  const chunkBodyParser = express.raw({
    type: 'application/octet-stream',
    limit: 36 * 1024 * 1024,
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'waqas-zip-to-web', timestamp: Date.now() });
  });

  app.get('/api/session', async (req, res) => {
    const token = resolveWorkspaceToken(req, res);
    const capabilities = await probeHostCapabilities();
    res.json({ workspaceToken: token, capabilities });
  });

  app.get('/api/capabilities', async (_req, res) => {
    const capabilities = await probeHostCapabilities(true);
    res.json(capabilities);
  });

  app.get('/api/system/source-zip', async (_req, res, next) => {
    try {
      await streamSourceCodeZip(res);
    } catch (err) {
      next(err);
    }
  });

  // --- MULTIPART RESUMABLE UPLOAD API ---

  app.post('/api/uploads/init', jsonParser, async (req, res) => {
    try {
      const ownerToken = resolveWorkspaceToken(req, res);
      const { filename, totalSize, chunkSize, sha256Expected } = req.body || {};
      const session = await initMultipartUpload({
        ownerToken,
        filename: String(filename || ''),
        totalSize: Number(totalSize),
        requestedChunkSize: chunkSize ? Number(chunkSize) : undefined,
        sha256Expected: sha256Expected ? String(sha256Expected) : null,
      });
      res.status(201).json({ session });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/uploads/:id', (req, res) => {
    const ownerToken = resolveWorkspaceToken(req, res);
    const session = getUploadSession(String(req.params.id));
    if (!session || session.owner_token !== ownerToken) {
      res.status(404).json({ error: 'Upload session not found.' });
      return;
    }
    res.json({ session });
  });

  app.post('/api/uploads/:id/pause', async (req, res) => {
    const ownerToken = resolveWorkspaceToken(req, res);
    const session = getUploadSession(String(req.params.id));
    if (!session || session.owner_token !== ownerToken) {
      res.status(404).json({ error: 'Upload session not found.' });
      return;
    }
    await closeWriteHandle(session.id);
    if (session.status === 'uploading') {
      updateUploadSession(session.id, { status: 'paused', updated_at: Date.now() });
    }
    res.json({ session: getUploadSession(session.id) });
  });

  app.post('/api/uploads/:id/resume', (req, res) => {
    const ownerToken = resolveWorkspaceToken(req, res);
    const session = getUploadSession(String(req.params.id));
    if (!session || session.owner_token !== ownerToken) {
      res.status(404).json({ error: 'Upload session not found.' });
      return;
    }
    if (session.status === 'paused') {
      updateUploadSession(session.id, { status: 'uploading', updated_at: Date.now() });
    }
    res.json({ session: getUploadSession(session.id) });
  });

  app.post('/api/uploads/:id/presign-batch', jsonParser, async (req, res) => {
    try {
      const ownerToken = resolveWorkspaceToken(req, res);
      const session = getUploadSession(String(req.params.id));
      if (!session || session.owner_token !== ownerToken) {
        res.status(404).json({ error: 'Upload session not found.' });
        return;
      }
      const indices = Array.isArray(req.body?.chunkIndices)
        ? (req.body.chunkIndices as unknown[]).map((n) => Number(n)).filter(Number.isInteger)
        : [];
      const parts = await getPresignedPartBatch(session, indices);
      res.json({ parts });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/uploads/:id/presign/:chunkIndex', async (req, res) => {
    try {
      const ownerToken = resolveWorkspaceToken(req, res);
      const session = getUploadSession(String(req.params.id));
      if (!session || session.owner_token !== ownerToken) {
        res.status(404).json({ error: 'Upload session not found.' });
        return;
      }
      const chunkIndex = Number(req.params.chunkIndex);
      const signed = await getPresignedPartUrl(session, chunkIndex);
      res.json(signed);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/uploads/:id/s3-part', jsonParser, (req, res) => {
    const ownerToken = resolveWorkspaceToken(req, res);
    const session = getUploadSession(String(req.params.id));
    if (!session || session.owner_token !== ownerToken) {
      res.status(404).json({ error: 'Upload session not found.' });
      return;
    }
    const { chunkIndex, etag } = req.body || {};
    if (typeof chunkIndex !== 'number' || !etag) {
      res.status(400).json({ error: 'chunkIndex and etag are required.' });
      return;
    }
    const updated = registerS3UploadedPart(session, chunkIndex, String(etag));
    res.json({ session: updated });
  });

  app.put('/api/uploads/:id/chunk/:chunkIndex', chunkBodyParser, async (req, res) => {
    try {
      const ownerToken = resolveWorkspaceToken(req, res);
      const session = getUploadSession(String(req.params.id));
      if (!session || session.owner_token !== ownerToken) {
        res.status(404).json({ error: 'Upload session not found.' });
        return;
      }
      const chunkIndex = Number(req.params.chunkIndex);
      if (!Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: 'Expected raw binary application/octet-stream chunk body.' });
        return;
      }
      const chunkSha256 = req.header('x-chunk-sha256');
      const updated = await writeLocalChunk({
        session,
        chunkIndex,
        buffer: req.body,
        chunkSha256,
      });
      res.json({ session: updated });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/uploads/:id/complete', jsonParser, async (req, res) => {
    try {
      const ownerToken = resolveWorkspaceToken(req, res);
      const session = getUploadSession(String(req.params.id));
      if (!session || session.owner_token !== ownerToken) {
        res.status(404).json({ error: 'Upload session not found.' });
        return;
      }

      const completed = await finalizeUpload(session);

      const projectId = generateId(12);
      const slug = sanitizeSlug(completed.filename);
      const projectName = completed.filename.replace(/\.zip$/i, '') || slug;
      const now = Date.now();

      const project: ProjectRecord = {
        id: projectId,
        slug,
        owner_token: ownerToken,
        name: projectName,
        source_upload_id: completed.id,
        framework: 'unknown',
        root_subpath: '',
        install_cmd: null,
        build_cmd: null,
        start_cmd: null,
        output_dir: null,
        status: 'queued',
        stage_message: 'Upload verified. Queued for extraction and build...',
        error_message: null,
        error_hint: null,
        live_url: null,
        preview_url: buildOwnerPreviewUrl(slug),
        hosting_provider: null,
        public_verification: null,
        internal_port: null,
        pid: null,
        file_count: 0,
        extracted_bytes: 0,
        build_duration_ms: null,
        created_at: now,
        updated_at: now,
        last_deployed_at: null,
      };

      createProject(project);

      const overrides: BuildOverrides | undefined = req.body?.overrides;
      enqueueBuildJob(
        project.id,
        {
          host: req.header('x-forwarded-host') || req.get('host'),
          proto: req.header('x-forwarded-proto') || req.protocol,
        },
        overrides
      );

      res.status(201).json({ session: completed, project });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/uploads/:id', async (req, res) => {
    const ownerToken = resolveWorkspaceToken(req, res);
    const session = getUploadSession(String(req.params.id));
    if (!session || session.owner_token !== ownerToken) {
      res.status(404).json({ error: 'Upload session not found.' });
      return;
    }
    await cancelOrDeleteUpload(session);
    res.json({ ok: true });
  });

  // --- PROJECTS & DEPLOYMENTS API ---

  app.get('/api/projects', (req, res) => {
    const ownerToken = resolveWorkspaceToken(req, res);
    const projects = listProjectsByOwner(ownerToken);
    res.json({ projects });
  });

  app.get('/api/projects/:id', (req, res) => {
    const ownerToken = resolveWorkspaceToken(req, res);
    const project = getProjectById(String(req.params.id));
    if (!project || project.owner_token !== ownerToken) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const logs = getBuildLogs(project.id);
    res.json({ project, logs });
  });

  app.get('/api/projects/:id/events', (req, res) => {
    const ownerToken = resolveWorkspaceToken(req, res);
    const project = getProjectById(String(req.params.id));
    if (!project || project.owner_token !== ownerToken) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const afterSeq = Number(req.query.afterSeq || 0);
    const initialLogs = getBuildLogs(project.id, Number.isFinite(afterSeq) ? afterSeq : 0);
    res.write(`data: ${JSON.stringify({ type: 'init', project, logs: initialLogs })}\n\n`);

    const onEvent = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const eventKey = `project:${project.id}`;
    buildEvents.on(eventKey, onEvent);

    const heartbeat = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      buildEvents.off(eventKey, onEvent);
    });
  });

  app.post('/api/projects/:id/redeploy', jsonParser, (req, res) => {
    const ownerToken = resolveWorkspaceToken(req, res);
    const project = getProjectById(String(req.params.id));
    if (!project || project.owner_token !== ownerToken) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const overrides: BuildOverrides | undefined = req.body?.overrides;
    updateProject(project.id, {
      status: 'queued',
      stage_message: 'Queued for rebuild and redeployment...',
      error_message: null,
      error_hint: null,
    });
    enqueueBuildJob(
      project.id,
      {
        host: req.header('x-forwarded-host') || req.get('host'),
        proto: req.header('x-forwarded-proto') || req.protocol,
      },
      overrides
    );
    res.json({ project: getProjectById(project.id) });
  });

  app.post('/api/projects/:id/restart', async (req, res) => {
    try {
      const ownerToken = resolveWorkspaceToken(req, res);
      const project = getProjectById(String(req.params.id));
      if (!project || project.owner_token !== ownerToken) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (!project.start_cmd) {
        const updated = await verifyAndPublishExistingProject(project.id);
        res.json({ project: updated || getProjectById(project.id) });
        return;
      }
      const rootDir = resolveProjectRootForProject(project);
      await startDynamicDeployment(project, rootDir, (level, msg) => {
        appendBuildLog(project.id, level, 'restart', msg);
      });
      const updated = await verifyAndPublishExistingProject(project.id);
      res.json({ project: updated || getProjectById(project.id) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/projects/:id/verify-public', async (req, res) => {
    try {
      const ownerToken = resolveWorkspaceToken(req, res);
      const project = getProjectById(String(req.params.id));
      if (!project || project.owner_token !== ownerToken) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      const updated = await verifyAndPublishExistingProject(project.id);
      res.json({ project: updated });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/projects/:id/stop', async (req, res) => {
    const ownerToken = resolveWorkspaceToken(req, res);
    const project = getProjectById(String(req.params.id));
    if (!project || project.owner_token !== ownerToken) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    await stopProjectRuntime(project.id);
    updateProject(project.id, {
      status: 'stopped',
      stage_message: 'Deployment stopped by user',
    });
    res.json({ project: getProjectById(project.id) });
  });

  app.delete('/api/projects/:id', async (req, res) => {
    const ownerToken = resolveWorkspaceToken(req, res);
    const project = getProjectById(String(req.params.id));
    if (!project || project.owner_token !== ownerToken) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    markProjectCancelled(project.id);
    await stopProjectRuntime(project.id);
    const workspaceDir = resolveSafePath(config.workspacesDir, project.id);
    const artifactDir = resolveArtifactDirForProject(project);
    await Promise.all([
      fsp.rm(workspaceDir, { recursive: true, force: true }).catch(() => {}),
      fsp.rm(artifactDir, { recursive: true, force: true }).catch(() => {}),
    ]);
    deleteProjectRecord(project.id);
    if (project.source_upload_id && countProjectsByUploadId(project.source_upload_id) === 0) {
      const upload = getUploadSession(project.source_upload_id);
      if (upload) {
        await cancelOrDeleteUpload(upload).catch(() => {});
        deleteUploadRecord(upload.id);
      }
    }
    res.json({ ok: true });
  });

  // 4. Vite dev middleware or static production frontend
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  app.listen(config.port, '0.0.0.0', async () => {
    console.log(`WAQAS ZIP TO WEB server listening on http://0.0.0.0:${config.port}`);
    await cleanupAbandonedUploads().catch(() => {});
    await restoreLiveDeploymentsOnBoot().catch(() => {});
  });

  // Optional strictly-isolated public sites HTTP listener (serves ONLY deployed sites, zero /api/* or workspace routes)
  if (config.publicSitesPort > 0 && config.publicSitesPort !== config.port) {
    const publicApp = express();
    publicApp.set('trust proxy', true);
    if (config.publicBaseDomain) {
      publicApp.use((req: Request, res: Response, next: NextFunction) => {
        const host = (req.hostname || '').toLowerCase();
        const suffix = `.${config.publicBaseDomain}`;
        if (host.endsWith(suffix) && host.length > suffix.length) {
          const slug = host.slice(0, host.length - suffix.length);
          if (/^[a-z0-9-]+$/.test(slug)) {
            serveDeployedSiteRequest(req, res, slug, req.path, true).catch(next);
            return;
          }
        }
        next();
      });
    }
    publicApp.use('/sites/:slug', (req: Request, res: Response, next: NextFunction) => {
      const slug = String(req.params.slug || '');
      if (!/^[a-z0-9-]+$/.test(slug)) {
        res.status(400).send('Invalid site slug.');
        return;
      }
      if (req.originalUrl === `/sites/${slug}` || req.originalUrl.startsWith(`/sites/${slug}?`)) {
        const qIdx = req.originalUrl.indexOf('?');
        const qs = qIdx >= 0 ? req.originalUrl.slice(qIdx) : '';
        res.redirect(301, `/sites/${slug}/${qs}`);
        return;
      }
      serveDeployedSiteRequest(req, res, slug, req.path || '/', false).catch(next);
    });
    publicApp.use((_req, res) => {
      res.status(404).send('Not found');
    });
    publicApp.listen(config.publicSitesPort, '0.0.0.0', () => {
      console.log(`Isolated public-sites listener active on http://0.0.0.0:${config.publicSitesPort}`);
    });
  }

  setInterval(() => {
    cleanupAbandonedUploads().catch(() => {});
  }, 30 * 60 * 1000).unref();
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
