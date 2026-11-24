import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config, probeHostCapabilities } from './config.ts';
import {
  createUploadSession,
  getUploadSession,
  listExpiredUploads,
  recordUploadChunkAtomic,
  updateUploadSession,
  type UploadSession,
} from './db.ts';
import { generateId, resolveSafePath } from './security.ts';

let s3Client: S3Client | null = null;
const openFileHandles = new Map<string, { handle: fsp.FileHandle; lastUsed: number }>();
const pendingHandleOpens = new Map<string, Promise<fsp.FileHandle>>();

async function getWriteHandle(uploadId: string, filePath: string): Promise<fsp.FileHandle> {
  const cached = openFileHandles.get(uploadId);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.handle;
  }
  const inFlight = pendingHandleOpens.get(uploadId);
  if (inFlight) {
    return await inFlight;
  }
  const openPromise = fsp.open(filePath, 'r+').then(
    (handle) => {
      openFileHandles.set(uploadId, { handle, lastUsed: Date.now() });
      pendingHandleOpens.delete(uploadId);
      return handle;
    },
    (err) => {
      pendingHandleOpens.delete(uploadId);
      throw err;
    }
  );
  pendingHandleOpens.set(uploadId, openPromise);
  return await openPromise;
}

export async function closeWriteHandle(uploadId: string): Promise<void> {
  const inFlight = pendingHandleOpens.get(uploadId);
  if (inFlight) {
    await inFlight.catch(() => {});
  }
  const cached = openFileHandles.get(uploadId);
  if (cached) {
    openFileHandles.delete(uploadId);
    await cached.handle.close().catch(() => {});
  }
}

setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [id, entry] of openFileHandles.entries()) {
    if (entry.lastUsed < cutoff) {
      openFileHandles.delete(id);
      void entry.handle.close().catch(() => {});
    }
  }
}, 30_000).unref();

function getS3Client(): S3Client {
  if (s3Client) return s3Client;
  s3Client = new S3Client({
    region: config.s3.region || 'auto',
    endpoint: config.s3.endpoint || undefined,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    },
  });
  return s3Client;
}

export function getLocalUploadFilePath(uploadId: string): string {
  if (!/^[a-f0-9]{16,64}$/.test(uploadId)) {
    throw new Error('Invalid upload ID');
  }
  return resolveSafePath(config.uploadsDir, `${uploadId}.zip.part`);
}

export async function initMultipartUpload(params: {
  ownerToken: string;
  filename: string;
  totalSize: number;
  requestedChunkSize?: number;
  sha256Expected?: string | null;
}): Promise<UploadSession> {
  const caps = await probeHostCapabilities();
  const safeName = path.basename(params.filename || 'project.zip');
  if (!safeName.toLowerCase().endsWith('.zip')) {
    throw new Error('Only .zip archives are supported.');
  }
  if (!Number.isFinite(params.totalSize) || params.totalSize <= 0) {
    throw new Error('Archive size must be greater than 0 bytes.');
  }
  if (params.totalSize > caps.effectiveMaxUploadBytes) {
    const limitMb = (caps.effectiveMaxUploadBytes / (1024 * 1024)).toFixed(0);
    throw new Error(
      `Archive size exceeds current host storage capacity limit (${limitMb} MB available).`
    );
  }

  const id = generateId(16);
  const minChunk = caps.storageDriver === 's3-multipart' ? 5 * 1024 * 1024 : 512 * 1024;
  const requested =
    params.requestedChunkSize && Number.isFinite(params.requestedChunkSize)
      ? Math.floor(params.requestedChunkSize)
      : caps.chunkSizeBytes;
  const chunkSize = Math.max(minChunk, Math.min(caps.maxChunkSizeBytes, requested));
  const totalChunks = Math.ceil(params.totalSize / chunkSize);
  const now = Date.now();

  let s3UploadId: string | null = null;
  let s3Key: string | null = null;

  if (caps.storageDriver === 's3-multipart') {
    const client = getS3Client();
    s3Key = `uploads/${params.ownerToken.slice(0, 12)}/${id}/${safeName}`;
    const created = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: config.s3.bucket,
        Key: s3Key,
        ContentType: 'application/zip',
      })
    );
    s3UploadId = created.UploadId || null;
  } else {
    const filePath = getLocalUploadFilePath(id);
    const handle = await fsp.open(filePath, 'w');
    try {
      await handle.truncate(params.totalSize);
    } finally {
      await handle.close();
    }
  }

  const session: UploadSession = {
    id,
    owner_token: params.ownerToken,
    filename: safeName,
    total_size: params.totalSize,
    chunk_size: chunkSize,
    total_chunks: totalChunks,
    uploaded_chunks: [],
    sha256_expected: params.sha256Expected || null,
    sha256_actual: null,
    storage_driver: caps.storageDriver,
    s3_upload_id: s3UploadId,
    s3_key: s3Key,
    s3_parts: [],
    status: 'uploading',
    bytes_received: 0,
    created_at: now,
    updated_at: now,
  };

  createUploadSession(session);
  return session;
}

export async function getPresignedPartUrl(
  session: UploadSession,
  chunkIndex: number
): Promise<{ url: string; partNumber: number }> {
  if (session.storage_driver !== 's3-multipart' || !session.s3_upload_id || !session.s3_key) {
    throw new Error('Session is not using S3 multipart storage.');
  }
  const partNumber = chunkIndex + 1;
  const client = getS3Client();
  const cmd = new UploadPartCommand({
    Bucket: config.s3.bucket,
    Key: session.s3_key,
    UploadId: session.s3_upload_id,
    PartNumber: partNumber,
  });
  const url = await getSignedUrl(client, cmd, { expiresIn: 900 });
  return { url, partNumber };
}

export async function getPresignedPartBatch(
  session: UploadSession,
  chunkIndices: number[]
): Promise<Array<{ chunkIndex: number; partNumber: number; url: string }>> {
  if (session.storage_driver !== 's3-multipart' || !session.s3_upload_id || !session.s3_key) {
    throw new Error('Session is not using S3 multipart storage.');
  }
  const client = getS3Client();
  const capped = chunkIndices.slice(0, 64);
  return await Promise.all(
    capped.map(async (chunkIndex) => {
      const partNumber = chunkIndex + 1;
      const cmd = new UploadPartCommand({
        Bucket: config.s3.bucket,
        Key: session.s3_key!,
        UploadId: session.s3_upload_id!,
        PartNumber: partNumber,
      });
      const url = await getSignedUrl(client, cmd, { expiresIn: 900 });
      return { chunkIndex, partNumber, url };
    })
  );
}

export async function writeLocalChunk(params: {
  session: UploadSession;
  chunkIndex: number;
  buffer: Buffer;
  chunkSha256?: string;
}): Promise<UploadSession> {
  const { session, chunkIndex, buffer, chunkSha256 } = params;
  if (session.storage_driver !== 'local-multipart') {
    throw new Error('Session uses S3 direct upload; upload parts directly to the signed S3 URL.');
  }
  if (session.status === 'cancelled' || session.status === 'completed') {
    throw new Error(`Upload cannot accept chunks while status is '${session.status}'.`);
  }
  if (chunkIndex < 0 || chunkIndex >= session.total_chunks) {
    throw new Error(`Chunk index ${chunkIndex} out of bounds (0..${session.total_chunks - 1}).`);
  }

  const expectedStart = chunkIndex * session.chunk_size;
  const expectedLength = Math.min(session.chunk_size, session.total_size - expectedStart);
  if (buffer.length !== expectedLength) {
    throw new Error(
      `Chunk ${chunkIndex} size mismatch: expected ${expectedLength} bytes, got ${buffer.length} bytes.`
    );
  }

  if (chunkSha256) {
    const actualChunkHash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actualChunkHash.toLowerCase() !== chunkSha256.toLowerCase()) {
      throw new Error(`Chunk ${chunkIndex} integrity check failed (SHA-256 mismatch).`);
    }
  }

  const filePath = getLocalUploadFilePath(session.id);
  const handle = await getWriteHandle(session.id, filePath);
  await handle.write(buffer, 0, buffer.length, expectedStart);

  return recordUploadChunkAtomic(session.id, chunkIndex, buffer.length, null)!;
}

export function registerS3UploadedPart(
  session: UploadSession,
  chunkIndex: number,
  etag: string
): UploadSession {
  const expectedStart = chunkIndex * session.chunk_size;
  const byteLength = Math.max(0, Math.min(session.chunk_size, session.total_size - expectedStart));
  return recordUploadChunkAtomic(session.id, chunkIndex, byteLength, etag)!;
}

export async function finalizeUpload(session: UploadSession): Promise<UploadSession> {
  await closeWriteHandle(session.id);
  const fresh = getUploadSession(session.id) || session;

  if (fresh.uploaded_chunks.length !== fresh.total_chunks) {
    throw new Error(
      `Upload incomplete: ${fresh.uploaded_chunks.length} of ${fresh.total_chunks} chunks uploaded.`
    );
  }

  if (fresh.storage_driver === 's3-multipart') {
    if (!fresh.s3_upload_id || !fresh.s3_key) {
      throw new Error('Missing S3 multipart metadata.');
    }
    const client = getS3Client();
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: config.s3.bucket,
        Key: fresh.s3_key,
        UploadId: fresh.s3_upload_id,
        MultipartUpload: {
          Parts: fresh.s3_parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      })
    );

    updateUploadSession(fresh.id, {
      status: 'completed',
      uploaded_chunks: fresh.uploaded_chunks,
      s3_parts: fresh.s3_parts,
      sha256_actual: fresh.sha256_expected,
      updated_at: Date.now(),
    });
    return getUploadSession(fresh.id)!;
  }

  const filePath = getLocalUploadFilePath(fresh.id);
  const stat = await fsp.stat(filePath);
  if (stat.size !== fresh.total_size) {
    throw new Error(
      `File size verification failed: expected ${fresh.total_size} bytes, got ${stat.size} bytes.`
    );
  }

  const sha256Actual = await computeFileSha256(filePath);
  if (
    fresh.sha256_expected &&
    sha256Actual.toLowerCase() !== fresh.sha256_expected.toLowerCase()
  ) {
    throw new Error(
      `SHA-256 integrity mismatch: expected ${fresh.sha256_expected}, got ${sha256Actual}.`
    );
  }

  updateUploadSession(fresh.id, {
    status: 'completed',
    uploaded_chunks: fresh.uploaded_chunks,
    bytes_received: fresh.total_size,
    sha256_actual: sha256Actual,
    updated_at: Date.now(),
  });
  return getUploadSession(fresh.id)!;
}

export async function computeFileSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function materializeUploadToLocalFile(session: UploadSession): Promise<{
  zipPath: string;
  cleanupAfterExtract: boolean;
}> {
  if (session.storage_driver === 'local-multipart') {
    return { zipPath: getLocalUploadFilePath(session.id), cleanupAfterExtract: false };
  }
  if (!session.s3_key) {
    throw new Error('Missing S3 key for upload.');
  }
  const client = getS3Client();
  const response = await client.send(
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: session.s3_key })
  );
  if (!response.Body) {
    throw new Error('Empty S3 object stream.');
  }
  const tempPath = getLocalUploadFilePath(session.id);
  await pipeline(response.Body as NodeJS.ReadableStream, fs.createWriteStream(tempPath));
  return { zipPath: tempPath, cleanupAfterExtract: true };
}

export async function cancelOrDeleteUpload(session: UploadSession): Promise<void> {
  await closeWriteHandle(session.id);
  if (session.storage_driver === 's3-multipart' && session.s3_upload_id && session.s3_key) {
    try {
      const client = getS3Client();
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: config.s3.bucket,
          Key: session.s3_key,
          UploadId: session.s3_upload_id,
        })
      );
    } catch {
      // Ignore if already aborted/completed
    }
  }
  const filePath = getLocalUploadFilePath(session.id);
  await fsp.rm(filePath, { force: true }).catch(() => {});
  updateUploadSession(session.id, { status: 'cancelled', updated_at: Date.now() });
}

export async function cleanupAbandonedUploads(): Promise<number> {
  const cutoff = Date.now() - config.cleanupAbandonedHours * 60 * 60 * 1000;
  const expired = listExpiredUploads(cutoff);
  let cleaned = 0;
  for (const session of expired) {
    await cancelOrDeleteUpload(session);
    updateUploadSession(session.id, { status: 'expired', updated_at: Date.now() });
    cleaned++;
  }
  return cleaned;
}
