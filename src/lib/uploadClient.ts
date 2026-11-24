import type { HostCapabilities, ProjectRecord, UploadSession } from '../types.ts';

export interface UploadProgressSnapshot {
  sessionId: string | null;
  filename: string;
  totalBytes: number;
  uploadedBytes: number;
  completedChunks: number;
  totalChunks: number;
  failedChunks: number;
  concurrency: number;
  chunkSizeBytes: number;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  state: 'idle' | 'hashing' | 'uploading' | 'paused' | 'verifying' | 'completed' | 'cancelled' | 'error';
  storageDriver: 'local-multipart' | 's3-multipart';
  errorMessage: string | null;
}

export interface AdaptiveTransferPlan {
  chunkSizeBytes: number;
  concurrency: number;
}

export function chooseAdaptiveTransferPlan(
  fileSize: number,
  capabilities: HostCapabilities | null
): AdaptiveTransferPlan {
  const isS3 = capabilities?.storageDriver === 's3-multipart';
  const maxChunk = capabilities?.maxChunkSizeBytes ?? (isS3 ? 16 * 1024 * 1024 : 16 * 1024 * 1024);
  const nav = typeof navigator !== 'undefined' ? (navigator as unknown as {
    connection?: { effectiveType?: string; downlink?: number; saveData?: boolean };
    hardwareConcurrency?: number;
  }) : undefined;
  const conn = nav?.connection;
  const effectiveType = conn?.effectiveType || '';
  const downlinkMbps = conn?.downlink ?? 25;
  const saveData = Boolean(conn?.saveData);

  let chunkSizeBytes: number;
  let concurrency: number;

  if (saveData || effectiveType === 'slow-2g' || effectiveType === '2g') {
    chunkSizeBytes = isS3 ? 5 * 1024 * 1024 : 1 * 1024 * 1024;
    concurrency = 2;
  } else if (effectiveType === '3g' || downlinkMbps < 5) {
    chunkSizeBytes = isS3 ? 5 * 1024 * 1024 : 2 * 1024 * 1024;
    concurrency = 3;
  } else if (fileSize < 16 * 1024 * 1024) {
    chunkSizeBytes = isS3 ? 5 * 1024 * 1024 : 2 * 1024 * 1024;
    concurrency = 4;
  } else if (fileSize < 150 * 1024 * 1024) {
    chunkSizeBytes = isS3 ? 8 * 1024 * 1024 : 4 * 1024 * 1024;
    concurrency = 5;
  } else {
    chunkSizeBytes = isS3 ? 10 * 1024 * 1024 : 8 * 1024 * 1024;
    concurrency = 6;
  }

  chunkSizeBytes = Math.min(maxChunk, Math.max(isS3 ? 5 * 1024 * 1024 : 512 * 1024, chunkSizeBytes));
  return { chunkSizeBytes, concurrency };
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return '';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return 'Calculating...';
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  return `${m}m ${s}s left`;
}

export class ResumableZipUploader {
  private file: File;
  private workspaceToken: string;
  private capabilities: HostCapabilities | null;
  private onProgress: (snap: UploadProgressSnapshot) => void;
  private session: UploadSession | null = null;
  private paused = false;
  private cancelled = false;
  private activeXhrs = new Set<XMLHttpRequest>();
  private completedSet = new Set<number>();
  private failedSet = new Set<number>();
  private inFlightLoaded = new Map<number, number>();
  private speedSamples: Array<{ t: number; totalBytes: number }> = [];
  private concurrency = 4;
  private chunkSizeBytes = 4 * 1024 * 1024;
  private s3UrlCache = new Map<number, string>();
  private lastEmitAt = 0;

  constructor(
    file: File,
    workspaceToken: string,
    onProgress: (snap: UploadProgressSnapshot) => void,
    capabilities: HostCapabilities | null = null
  ) {
    this.file = file;
    this.workspaceToken = workspaceToken;
    this.onProgress = onProgress;
    this.capabilities = capabilities;
    const plan = chooseAdaptiveTransferPlan(file.size, capabilities);
    this.concurrency = plan.concurrency;
    this.chunkSizeBytes = plan.chunkSizeBytes;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'X-Workspace-Token': this.workspaceToken,
      ...extra,
    };
  }

  private currentUploadedBytes(): number {
    let completedBytes = 0;
    const chunkSize = this.session?.chunk_size ?? this.chunkSizeBytes;
    const totalChunks = this.session?.total_chunks ?? 0;
    for (const idx of this.completedSet) {
      const start = idx * chunkSize;
      const len = idx === totalChunks - 1 ? this.file.size - start : chunkSize;
      completedBytes += Math.max(0, len);
    }
    let inflightBytes = 0;
    for (const [idx, loaded] of this.inFlightLoaded.entries()) {
      if (!this.completedSet.has(idx)) {
        inflightBytes += loaded;
      }
    }
    return Math.min(this.file.size, completedBytes + inflightBytes);
  }

  private recordTotalProgress(uploadedBytes: number) {
    const now = Date.now();
    this.speedSamples.push({ t: now, totalBytes: uploadedBytes });
    this.speedSamples = this.speedSamples.filter((s) => now - s.t <= 4000);
  }

  private computeSpeed(): number {
    if (this.speedSamples.length < 2) return 0;
    const first = this.speedSamples[0];
    const last = this.speedSamples[this.speedSamples.length - 1];
    const deltaBytes = last.totalBytes - first.totalBytes;
    const deltaSec = (last.t - first.t) / 1000;
    if (deltaBytes <= 0 || deltaSec <= 0.15) return 0;
    return deltaBytes / deltaSec;
  }

  private emit(partial: Partial<UploadProgressSnapshot>, force = false) {
    const now = Date.now();
    if (!force && partial.state === 'uploading' && now - this.lastEmitAt < 80) {
      return;
    }
    this.lastEmitAt = now;

    const uploadedBytes = partial.uploadedBytes ?? this.currentUploadedBytes();
    const speedBytesPerSec = partial.speedBytesPerSec ?? this.computeSpeed();
    const base: UploadProgressSnapshot = {
      sessionId: this.session?.id ?? null,
      filename: this.file.name,
      totalBytes: this.file.size,
      uploadedBytes,
      completedChunks: this.completedSet.size,
      totalChunks: this.session?.total_chunks ?? Math.ceil(this.file.size / this.chunkSizeBytes),
      failedChunks: this.failedSet.size,
      concurrency: this.concurrency,
      chunkSizeBytes: this.session?.chunk_size ?? this.chunkSizeBytes,
      speedBytesPerSec,
      etaSeconds: null,
      state: 'uploading',
      storageDriver: this.session?.storage_driver ?? this.capabilities?.storageDriver ?? 'local-multipart',
      errorMessage: null,
    };
    const merged = { ...base, ...partial };
    if (merged.speedBytesPerSec > 0 && merged.totalBytes > merged.uploadedBytes) {
      merged.etaSeconds = (merged.totalBytes - merged.uploadedBytes) / merged.speedBytesPerSec;
    }
    this.onProgress(merged);
  }

  async start(): Promise<ProjectRecord> {
    this.cancelled = false;
    this.paused = false;

    if (!this.session) {
      const plan = chooseAdaptiveTransferPlan(this.file.size, this.capabilities);
      this.chunkSizeBytes = plan.chunkSizeBytes;
      this.concurrency = plan.concurrency;

      const initRes = await fetch('/api/uploads/init', {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          filename: this.file.name,
          totalSize: this.file.size,
          chunkSize: plan.chunkSizeBytes,
          sha256Expected: null,
        }),
      });
      const initJson = await initRes.json();
      if (!initRes.ok) {
        throw new Error(initJson.error || 'Failed to initialize upload session.');
      }
      this.session = initJson.session as UploadSession;
      this.chunkSizeBytes = this.session.chunk_size;
      this.completedSet = new Set(this.session.uploaded_chunks);
    } else {
      await fetch(`/api/uploads/${this.session.id}/resume`, {
        method: 'POST',
        headers: this.headers(),
      });
      const stateRes = await fetch(`/api/uploads/${this.session.id}`, {
        headers: this.headers(),
      });
      if (stateRes.ok) {
        const data = await stateRes.json();
        this.session = data.session as UploadSession;
        this.completedSet = new Set(this.session.uploaded_chunks);
      }
    }

    this.speedSamples = [{ t: Date.now(), totalBytes: this.currentUploadedBytes() }];
    this.emit({ state: 'uploading' }, true);
    return await this.runParallelUpload();
  }

  async pause(): Promise<void> {
    this.paused = true;
    for (const xhr of this.activeXhrs) {
      try {
        xhr.abort();
      } catch {
        // ignore
      }
    }
    this.activeXhrs.clear();
    this.inFlightLoaded.clear();
    if (this.session) {
      await fetch(`/api/uploads/${this.session.id}/pause`, {
        method: 'POST',
        headers: this.headers(),
      }).catch(() => {});
    }
    this.emit({ state: 'paused', speedBytesPerSec: 0 }, true);
  }

  async resume(): Promise<ProjectRecord> {
    this.paused = false;
    return await this.start();
  }

  async retryFailed(): Promise<ProjectRecord> {
    this.failedSet.clear();
    return await this.start();
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.paused = false;
    for (const xhr of this.activeXhrs) {
      try {
        xhr.abort();
      } catch {
        // ignore
      }
    }
    this.activeXhrs.clear();
    this.inFlightLoaded.clear();
    if (this.session) {
      await fetch(`/api/uploads/${this.session.id}`, {
        method: 'DELETE',
        headers: this.headers(),
      }).catch(() => {});
    }
    this.emit({ state: 'cancelled', speedBytesPerSec: 0 }, true);
  }

  private uploadChunkViaXhr(
    url: string,
    body: ArrayBuffer,
    headers: Record<string, string>,
    chunkIndex: number
  ): Promise<{ status: number; responseText: string; etag: string | null }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.activeXhrs.add(xhr);
      xhr.open('PUT', url, true);
      for (const [k, v] of Object.entries(headers)) {
        xhr.setRequestHeader(k, v);
      }

      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable) {
          this.inFlightLoaded.set(chunkIndex, evt.loaded);
          const totalNow = this.currentUploadedBytes();
          this.recordTotalProgress(totalNow);
          this.emit({ state: 'uploading', uploadedBytes: totalNow });
        }
      };

      xhr.onload = () => {
        this.activeXhrs.delete(xhr);
        this.inFlightLoaded.delete(chunkIndex);
        resolve({
          status: xhr.status,
          responseText: xhr.responseText || '',
          etag: xhr.getResponseHeader('etag'),
        });
      };

      xhr.onerror = () => {
        this.activeXhrs.delete(xhr);
        this.inFlightLoaded.delete(chunkIndex);
        reject(new Error(`Network interruption while uploading chunk ${chunkIndex + 1}.`));
      };

      xhr.onabort = () => {
        this.activeXhrs.delete(xhr);
        this.inFlightLoaded.delete(chunkIndex);
        reject(new Error(this.paused ? 'UPLOAD_PAUSED' : 'Upload cancelled.'));
      };

      xhr.send(body);
    });
  }

  private async uploadSingleChunk(idx: number): Promise<void> {
    if (!this.session) throw new Error('No active upload session.');
    const chunkSize = this.session.chunk_size;
    const start = idx * chunkSize;
    const end = Math.min(this.file.size, start + chunkSize);
    const buffer = await this.file.slice(start, end).arrayBuffer();
    const chunkHash = await sha256Hex(buffer);

    let attempt = 0;
    const maxAttempts = 4;
    while (attempt < maxAttempts) {
      if (this.cancelled) throw new Error('Upload cancelled by user.');
      if (this.paused) throw new Error('UPLOAD_PAUSED');

      try {
        if (this.session.storage_driver === 's3-multipart') {
          let signedUrl = this.s3UrlCache.get(idx);
          if (!signedUrl) {
            const signRes = await fetch(`/api/uploads/${this.session.id}/presign/${idx}`, {
              headers: this.headers(),
            });
            const signJson = await signRes.json();
            if (!signRes.ok) throw new Error(signJson.error || 'Failed to get presigned URL.');
            signedUrl = String(signJson.url);
          }

          const putRes = await this.uploadChunkViaXhr(signedUrl, buffer, {}, idx);
          if (putRes.status < 200 || putRes.status >= 300) {
            throw new Error(`Object storage part upload failed (HTTP ${putRes.status}).`);
          }
          const etag = putRes.etag || `"part-${idx + 1}"`;

          const regRes = await fetch(`/api/uploads/${this.session.id}/s3-part`, {
            method: 'POST',
            headers: this.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ chunkIndex: idx, etag }),
          });
          if (!regRes.ok) {
            const regErr = await regRes.json().catch(() => ({}));
            throw new Error(regErr.error || 'Failed to register uploaded S3 part.');
          }
        } else {
          const putRes = await this.uploadChunkViaXhr(
            `/api/uploads/${this.session.id}/chunk/${idx}`,
            buffer,
            this.headers({
              'Content-Type': 'application/octet-stream',
              ...(chunkHash ? { 'X-Chunk-SHA256': chunkHash } : {}),
            }),
            idx
          );
          if (putRes.status < 200 || putRes.status >= 300) {
            let errMsg = `Chunk ${idx + 1} upload failed (HTTP ${putRes.status}).`;
            try {
              const parsed = JSON.parse(putRes.responseText);
              if (parsed.error) errMsg = parsed.error;
            } catch {
              // ignore
            }
            throw new Error(errMsg);
          }
        }

        this.completedSet.add(idx);
        this.failedSet.delete(idx);
        const totalNow = this.currentUploadedBytes();
        this.recordTotalProgress(totalNow);
        this.emit({ state: 'uploading', uploadedBytes: totalNow }, true);
        return;
      } catch (err) {
        if (this.paused || (err instanceof Error && err.message === 'UPLOAD_PAUSED')) {
          throw new Error('UPLOAD_PAUSED');
        }
        if (this.cancelled) throw new Error('Upload cancelled by user.');
        attempt += 1;
        if (attempt >= maxAttempts) {
          this.failedSet.add(idx);
          this.emit({ state: 'uploading' }, true);
          throw err instanceof Error ? err : new Error(String(err));
        }
        await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt - 1)));
      }
    }
  }

  private async runParallelUpload(): Promise<ProjectRecord> {
    if (!this.session) throw new Error('No active upload session.');

    const pendingIndices: number[] = [];
    for (let idx = 0; idx < this.session.total_chunks; idx++) {
      if (!this.completedSet.has(idx)) {
        pendingIndices.push(idx);
      }
    }

    if (this.session.storage_driver === 's3-multipart' && pendingIndices.length > 0) {
      try {
        for (let offset = 0; offset < pendingIndices.length; offset += 64) {
          const batch = pendingIndices.slice(offset, offset + 64);
          const batchRes = await fetch(`/api/uploads/${this.session.id}/presign-batch`, {
            method: 'POST',
            headers: this.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ chunkIndices: batch }),
          });
          if (batchRes.ok) {
            const data = await batchRes.json();
            for (const part of data.parts || []) {
              this.s3UrlCache.set(Number(part.chunkIndex), String(part.url));
            }
          }
        }
      } catch {
        // Fallback to single presign inside uploadSingleChunk
      }
    }

    let cursor = 0;
    let firstFatalError: Error | null = null;
    const workerCount = Math.min(this.concurrency, Math.max(1, pendingIndices.length));

    const worker = async () => {
      while (!firstFatalError && !this.paused && !this.cancelled) {
        const pos = cursor++;
        if (pos >= pendingIndices.length) return;
        const idx = pendingIndices[pos];
        try {
          await this.uploadSingleChunk(idx);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          if (!firstFatalError) firstFatalError = e;
          if (e.message === 'UPLOAD_PAUSED' || this.cancelled) return;
        }
      }
    };

    if (pendingIndices.length > 0) {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    }

    const fatalErr = firstFatalError as Error | null;
    if (this.cancelled) throw new Error('Upload cancelled by user.');
    if (this.paused || fatalErr?.message === 'UPLOAD_PAUSED') {
      this.emit({ state: 'paused', speedBytesPerSec: 0 }, true);
      throw new Error('UPLOAD_PAUSED');
    }
    if (fatalErr) {
      throw fatalErr;
    }
    if (this.failedSet.size > 0) {
      throw new Error(`${this.failedSet.size} chunk(s) failed to upload. Click Retry Failed Chunks to resume.`);
    }

    this.emit({ state: 'verifying', speedBytesPerSec: 0 }, true);
    const completeRes = await fetch(`/api/uploads/${this.session.id}/complete`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({}),
    });
    const completeJson = await completeRes.json();
    if (!completeRes.ok) {
      throw new Error(completeJson.error || 'Upload integrity verification failed.');
    }
    this.session = completeJson.session as UploadSession;
    this.emit({ state: 'completed', uploadedBytes: this.file.size, speedBytesPerSec: 0 }, true);
    return completeJson.project as ProjectRecord;
  }
}
