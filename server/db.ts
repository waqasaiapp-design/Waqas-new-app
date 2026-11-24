import { DatabaseSync } from 'node:sqlite';
import { config, ensureDataDirectories } from './config.ts';

export type ProjectFramework =
  | 'static'
  | 'react'
  | 'vite'
  | 'nextjs'
  | 'nodejs'
  | 'python'
  | 'dockerfile'
  | 'unknown';

export type ProjectStatus =
  | 'queued'
  | 'extracting'
  | 'detecting'
  | 'installing'
  | 'building'
  | 'deploying'
  | 'live'
  | 'public_blocked'
  | 'failed'
  | 'stopped';

export type UploadStatus = 'uploading' | 'paused' | 'completed' | 'cancelled' | 'expired';

export interface PublicVerificationReport {
  ok: boolean;
  checkedUrl: string;
  finalUrl: string | null;
  httpStatus: number | null;
  authWallDetected: boolean;
  redirectChain: string[];
  assetsChecked: number;
  failedAssets: Array<{ url: string; status: number | null; error?: string }>;
  error: string | null;
  verifiedAt: number;
}

export interface UploadSession {
  id: string;
  owner_token: string;
  filename: string;
  total_size: number;
  chunk_size: number;
  total_chunks: number;
  uploaded_chunks: number[];
  sha256_expected: string | null;
  sha256_actual: string | null;
  storage_driver: 'local-multipart' | 's3-multipart';
  s3_upload_id: string | null;
  s3_key: string | null;
  s3_parts: Array<{ partNumber: number; etag: string }>;
  status: UploadStatus;
  bytes_received: number;
  created_at: number;
  updated_at: number;
}

export interface ProjectRecord {
  id: string;
  slug: string;
  owner_token: string;
  name: string;
  source_upload_id: string;
  framework: ProjectFramework;
  root_subpath: string;
  install_cmd: string | null;
  build_cmd: string | null;
  start_cmd: string | null;
  output_dir: string | null;
  status: ProjectStatus;
  stage_message: string;
  error_message: string | null;
  error_hint: string | null;
  live_url: string | null;
  preview_url: string | null;
  hosting_provider: string | null;
  public_verification: PublicVerificationReport | null;
  internal_port: number | null;
  pid: number | null;
  file_count: number;
  extracted_bytes: number;
  build_duration_ms: number | null;
  created_at: number;
  updated_at: number;
  last_deployed_at: number | null;
}

export interface BuildLogEntry {
  id: number;
  project_id: string;
  seq: number;
  level: 'info' | 'stdout' | 'stderr' | 'success' | 'error';
  stage: string;
  message: string;
  created_at: number;
}

let dbInstance: DatabaseSync | null = null;

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

export function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;
  ensureDataDirectories();
  const db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS upload_sessions (
      id TEXT PRIMARY KEY,
      owner_token TEXT NOT NULL,
      filename TEXT NOT NULL,
      total_size INTEGER NOT NULL,
      chunk_size INTEGER NOT NULL,
      total_chunks INTEGER NOT NULL,
      uploaded_chunks_json TEXT NOT NULL DEFAULT '[]',
      sha256_expected TEXT,
      sha256_actual TEXT,
      storage_driver TEXT NOT NULL,
      s3_upload_id TEXT,
      s3_key TEXT,
      s3_parts_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'uploading',
      bytes_received INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_upload_owner ON upload_sessions(owner_token, updated_at DESC);

    CREATE TABLE IF NOT EXISTS upload_chunks (
      upload_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      byte_length INTEGER NOT NULL,
      etag TEXT,
      PRIMARY KEY (upload_id, chunk_index),
      FOREIGN KEY (upload_id) REFERENCES upload_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      owner_token TEXT NOT NULL,
      name TEXT NOT NULL,
      source_upload_id TEXT NOT NULL,
      framework TEXT NOT NULL DEFAULT 'unknown',
      root_subpath TEXT NOT NULL DEFAULT '',
      install_cmd TEXT,
      build_cmd TEXT,
      start_cmd TEXT,
      output_dir TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      stage_message TEXT NOT NULL DEFAULT 'Queued for processing',
      error_message TEXT,
      error_hint TEXT,
      live_url TEXT,
      preview_url TEXT,
      hosting_provider TEXT,
      public_verification_json TEXT,
      internal_port INTEGER,
      pid INTEGER,
      file_count INTEGER NOT NULL DEFAULT 0,
      extracted_bytes INTEGER NOT NULL DEFAULT 0,
      build_duration_ms INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_deployed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_token, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);

    CREATE TABLE IF NOT EXISTS build_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      level TEXT NOT NULL,
      stage TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_build_logs_project ON build_logs(project_id, seq ASC);
  `);

  // Safe non-destructive schema migrations for pre-existing databases
  ensureColumn(db, 'projects', 'preview_url', 'TEXT');
  ensureColumn(db, 'projects', 'hosting_provider', 'TEXT');
  ensureColumn(db, 'projects', 'public_verification_json', 'TEXT');

  dbInstance = db;
  return db;
}

function mapUploadRow(row: Record<string, unknown>): UploadSession {
  return {
    id: String(row.id),
    owner_token: String(row.owner_token),
    filename: String(row.filename),
    total_size: Number(row.total_size),
    chunk_size: Number(row.chunk_size),
    total_chunks: Number(row.total_chunks),
    uploaded_chunks: JSON.parse(String(row.uploaded_chunks_json || '[]')) as number[],
    sha256_expected: row.sha256_expected ? String(row.sha256_expected) : null,
    sha256_actual: row.sha256_actual ? String(row.sha256_actual) : null,
    storage_driver: row.storage_driver === 's3-multipart' ? 's3-multipart' : 'local-multipart',
    s3_upload_id: row.s3_upload_id ? String(row.s3_upload_id) : null,
    s3_key: row.s3_key ? String(row.s3_key) : null,
    s3_parts: JSON.parse(String(row.s3_parts_json || '[]')) as Array<{ partNumber: number; etag: string }>,
    status: String(row.status) as UploadStatus,
    bytes_received: Number(row.bytes_received),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function mapProjectRow(row: Record<string, unknown>): ProjectRecord {
  let publicVerification: PublicVerificationReport | null = null;
  if (row.public_verification_json) {
    try {
      publicVerification = JSON.parse(String(row.public_verification_json)) as PublicVerificationReport;
    } catch {
      publicVerification = null;
    }
  }
  return {
    id: String(row.id),
    slug: String(row.slug),
    owner_token: String(row.owner_token),
    name: String(row.name),
    source_upload_id: String(row.source_upload_id),
    framework: String(row.framework) as ProjectFramework,
    root_subpath: String(row.root_subpath || ''),
    install_cmd: row.install_cmd ? String(row.install_cmd) : null,
    build_cmd: row.build_cmd ? String(row.build_cmd) : null,
    start_cmd: row.start_cmd ? String(row.start_cmd) : null,
    output_dir: row.output_dir ? String(row.output_dir) : null,
    status: String(row.status) as ProjectStatus,
    stage_message: String(row.stage_message || ''),
    error_message: row.error_message ? String(row.error_message) : null,
    error_hint: row.error_hint ? String(row.error_hint) : null,
    live_url: row.live_url ? String(row.live_url) : null,
    preview_url: row.preview_url ? String(row.preview_url) : null,
    hosting_provider: row.hosting_provider ? String(row.hosting_provider) : null,
    public_verification: publicVerification,
    internal_port: row.internal_port !== null && row.internal_port !== undefined ? Number(row.internal_port) : null,
    pid: row.pid !== null && row.pid !== undefined ? Number(row.pid) : null,
    file_count: Number(row.file_count || 0),
    extracted_bytes: Number(row.extracted_bytes || 0),
    build_duration_ms: row.build_duration_ms !== null && row.build_duration_ms !== undefined ? Number(row.build_duration_ms) : null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    last_deployed_at: row.last_deployed_at !== null && row.last_deployed_at !== undefined ? Number(row.last_deployed_at) : null,
  };
}

export function createUploadSession(session: UploadSession): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO upload_sessions (
      id, owner_token, filename, total_size, chunk_size, total_chunks,
      uploaded_chunks_json, sha256_expected, sha256_actual, storage_driver,
      s3_upload_id, s3_key, s3_parts_json, status, bytes_received, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.id,
    session.owner_token,
    session.filename,
    session.total_size,
    session.chunk_size,
    session.total_chunks,
    JSON.stringify(session.uploaded_chunks),
    session.sha256_expected,
    session.sha256_actual,
    session.storage_driver,
    session.s3_upload_id,
    session.s3_key,
    JSON.stringify(session.s3_parts),
    session.status,
    session.bytes_received,
    session.created_at,
    session.updated_at
  );
}

export function getUploadSession(id: string): UploadSession | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const session = mapUploadRow(row);
  const chunkRows = db
    .prepare('SELECT chunk_index, byte_length, etag FROM upload_chunks WHERE upload_id = ? ORDER BY chunk_index ASC')
    .all(id) as Array<{ chunk_index: number; byte_length: number; etag: string | null }>;
  if (chunkRows.length > 0) {
    const mergedIndices = new Set<number>(session.uploaded_chunks);
    const partsMap = new Map<number, string>();
    for (const p of session.s3_parts) partsMap.set(p.partNumber, p.etag);
    let atomicBytes = 0;
    for (const cr of chunkRows) {
      const idx = Number(cr.chunk_index);
      mergedIndices.add(idx);
      atomicBytes += Number(cr.byte_length);
      if (cr.etag) {
        partsMap.set(idx + 1, String(cr.etag));
      }
    }
    session.uploaded_chunks = Array.from(mergedIndices).sort((a, b) => a - b);
    if (atomicBytes > session.bytes_received) {
      session.bytes_received = atomicBytes;
    }
    if (partsMap.size > 0) {
      session.s3_parts = Array.from(partsMap.entries())
        .map(([partNumber, etag]) => ({ partNumber, etag }))
        .sort((a, b) => a.partNumber - b.partNumber);
    }
  }
  return session;
}

export function recordUploadChunkAtomic(
  uploadId: string,
  chunkIndex: number,
  byteLength: number,
  etag: string | null = null
): UploadSession | null {
  const db = getDb();
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      'INSERT OR REPLACE INTO upload_chunks (upload_id, chunk_index, byte_length, etag) VALUES (?, ?, ?, ?)'
    ).run(uploadId, chunkIndex, byteLength, etag);
    const agg = db
      .prepare('SELECT COALESCE(SUM(byte_length), 0) AS totalBytes FROM upload_chunks WHERE upload_id = ?')
      .get(uploadId) as { totalBytes: number };
    db.prepare(
      "UPDATE upload_sessions SET bytes_received = ?, status = 'uploading', updated_at = ? WHERE id = ?"
    ).run(Number(agg.totalBytes), now, uploadId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getUploadSession(uploadId);
}

export function updateUploadSession(
  id: string,
  patch: Partial<Pick<UploadSession, 'uploaded_chunks' | 'sha256_actual' | 's3_parts' | 'status' | 'bytes_received' | 'updated_at'>>
): void {
  const current = getUploadSession(id);
  if (!current) return;
  const db = getDb();
  db.prepare(`
    UPDATE upload_sessions
    SET uploaded_chunks_json = ?, sha256_actual = ?, s3_parts_json = ?, status = ?, bytes_received = ?, updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify(patch.uploaded_chunks ?? current.uploaded_chunks),
    patch.sha256_actual !== undefined ? patch.sha256_actual : current.sha256_actual,
    JSON.stringify(patch.s3_parts ?? current.s3_parts),
    patch.status ?? current.status,
    patch.bytes_received ?? current.bytes_received,
    patch.updated_at ?? Date.now(),
    id
  );
}

export function listExpiredUploads(cutoffMs: number): UploadSession[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM upload_sessions WHERE status IN ('uploading', 'paused', 'cancelled') AND updated_at < ?`)
    .all(cutoffMs) as Record<string, unknown>[];
  return rows.map(mapUploadRow);
}

export function createProject(project: ProjectRecord): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO projects (
      id, slug, owner_token, name, source_upload_id, framework, root_subpath,
      install_cmd, build_cmd, start_cmd, output_dir, status, stage_message,
      error_message, error_hint, live_url, preview_url, hosting_provider,
      public_verification_json, internal_port, pid, file_count,
      extracted_bytes, build_duration_ms, created_at, updated_at, last_deployed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    project.id,
    project.slug,
    project.owner_token,
    project.name,
    project.source_upload_id,
    project.framework,
    project.root_subpath,
    project.install_cmd,
    project.build_cmd,
    project.start_cmd,
    project.output_dir,
    project.status,
    project.stage_message,
    project.error_message,
    project.error_hint,
    project.live_url,
    project.preview_url,
    project.hosting_provider,
    project.public_verification ? JSON.stringify(project.public_verification) : null,
    project.internal_port,
    project.pid,
    project.file_count,
    project.extracted_bytes,
    project.build_duration_ms,
    project.created_at,
    project.updated_at,
    project.last_deployed_at
  );
}

export function getProjectById(id: string): ProjectRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapProjectRow(row) : null;
}

export function getProjectBySlug(slug: string): ProjectRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as Record<string, unknown> | undefined;
  return row ? mapProjectRow(row) : null;
}

export function listProjectsByOwner(ownerToken: string): ProjectRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM projects WHERE owner_token = ? ORDER BY created_at DESC')
    .all(ownerToken) as Record<string, unknown>[];
  return rows.map(mapProjectRow);
}

export function listAllLiveProjects(): ProjectRecord[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM projects WHERE status IN ('live', 'public_blocked')`)
    .all() as Record<string, unknown>[];
  return rows.map(mapProjectRow);
}

export function updateProject(id: string, patch: Partial<ProjectRecord>): void {
  const current = getProjectById(id);
  if (!current) return;
  const db = getDb();
  const merged = { ...current, ...patch, updated_at: patch.updated_at ?? Date.now() };
  db.prepare(`
    UPDATE projects SET
      framework = ?, root_subpath = ?, install_cmd = ?, build_cmd = ?, start_cmd = ?,
      output_dir = ?, status = ?, stage_message = ?, error_message = ?, error_hint = ?,
      live_url = ?, preview_url = ?, hosting_provider = ?, public_verification_json = ?,
      internal_port = ?, pid = ?, file_count = ?, extracted_bytes = ?,
      build_duration_ms = ?, updated_at = ?, last_deployed_at = ?
    WHERE id = ?
  `).run(
    merged.framework,
    merged.root_subpath,
    merged.install_cmd,
    merged.build_cmd,
    merged.start_cmd,
    merged.output_dir,
    merged.status,
    merged.stage_message,
    merged.error_message,
    merged.error_hint,
    merged.live_url,
    merged.preview_url,
    merged.hosting_provider,
    merged.public_verification ? JSON.stringify(merged.public_verification) : null,
    merged.internal_port,
    merged.pid,
    merged.file_count,
    merged.extracted_bytes,
    merged.build_duration_ms,
    merged.updated_at,
    merged.last_deployed_at,
    id
  );
}

export function deleteProjectRecord(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

export function countProjectsByUploadId(sourceUploadId: string): number {
  const db = getDb();
  const row = db
    .prepare('SELECT COUNT(*) AS cnt FROM projects WHERE source_upload_id = ?')
    .get(sourceUploadId) as { cnt: number };
  return Number(row.cnt || 0);
}

export function deleteUploadRecord(uploadId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(uploadId);
}

export function appendBuildLog(
  projectId: string,
  level: BuildLogEntry['level'],
  stage: string,
  message: string
): BuildLogEntry | null {
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
  if (!exists) return null;
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM build_logs WHERE project_id = ?')
    .get(projectId) as { maxSeq: number };
  const nextSeq = Number(row.maxSeq) + 1;
  const now = Date.now();
  try {
    const result = db
      .prepare(
        'INSERT INTO build_logs (project_id, seq, level, stage, message, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(projectId, nextSeq, level, stage, message, now);
    return {
      id: Number(result.lastInsertRowid),
      project_id: projectId,
      seq: nextSeq,
      level,
      stage,
      message,
      created_at: now,
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes('FOREIGN KEY constraint failed')) {
      return null;
    }
    throw err;
  }
}

export function getBuildLogs(projectId: string, afterSeq = 0): BuildLogEntry[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM build_logs WHERE project_id = ? AND seq > ? ORDER BY seq ASC')
    .all(projectId, afterSeq) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    project_id: String(r.project_id),
    seq: Number(r.seq),
    level: String(r.level) as BuildLogEntry['level'],
    stage: String(r.stage),
    message: String(r.message),
    created_at: Number(r.created_at),
  }));
}

export function clearBuildLogs(projectId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM build_logs WHERE project_id = ?').run(projectId);
}
