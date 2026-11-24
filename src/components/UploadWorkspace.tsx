import React, { useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileArchive,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import type { HostCapabilities, ProjectRecord } from '../types.ts';
import {
  chooseAdaptiveTransferPlan,
  formatBytes,
  formatDuration,
  ResumableZipUploader,
  type UploadProgressSnapshot,
} from '../lib/uploadClient.ts';

interface UploadWorkspaceProps {
  workspaceToken: string;
  capabilities: HostCapabilities | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onDeploymentStarted: (project: ProjectRecord) => void;
}

export const UploadWorkspace: React.FC<UploadWorkspaceProps> = ({
  workspaceToken,
  capabilities,
  fileInputRef,
  onDeploymentStarted,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [snapshot, setSnapshot] = useState<UploadProgressSnapshot | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const uploaderRef = useRef<ResumableZipUploader | null>(null);

  const startFileUpload = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setSnapshot({
        sessionId: null,
        filename: file.name,
        totalBytes: file.size,
        uploadedBytes: 0,
        completedChunks: 0,
        totalChunks: 0,
        failedChunks: 0,
        concurrency: 1,
        chunkSizeBytes: capabilities?.chunkSizeBytes ?? 4 * 1024 * 1024,
        speedBytesPerSec: 0,
        etaSeconds: null,
        state: 'error',
        storageDriver: capabilities?.storageDriver ?? 'local-multipart',
        errorMessage: 'Please select a valid .zip archive file.',
      });
      return;
    }

    setSelectedFile(file);
    const plan = chooseAdaptiveTransferPlan(file.size, capabilities);
    const uploader = new ResumableZipUploader(
      file,
      workspaceToken,
      (nextSnap) => {
        setSnapshot(nextSnap);
      },
      capabilities
    );
    uploaderRef.current = uploader;

    setSnapshot({
      sessionId: null,
      filename: file.name,
      totalBytes: file.size,
      uploadedBytes: 0,
      completedChunks: 0,
      totalChunks: Math.ceil(file.size / plan.chunkSizeBytes),
      failedChunks: 0,
      concurrency: plan.concurrency,
      chunkSizeBytes: plan.chunkSizeBytes,
      speedBytesPerSec: 0,
      etaSeconds: null,
      state: 'uploading',
      storageDriver: capabilities?.storageDriver ?? 'local-multipart',
      errorMessage: null,
    });

    try {
      const project = await uploader.start();
      onDeploymentStarted(project);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'UPLOAD_PAUSED') return;
      setSnapshot((prev) =>
        prev
          ? {
              ...prev,
              state: prev.state === 'cancelled' ? 'cancelled' : 'error',
              speedBytesPerSec: 0,
              errorMessage: prev.state === 'cancelled' ? null : msg,
            }
          : null
      );
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void startFileUpload(file);
    }
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void startFileUpload(file);
    }
  };

  const handlePause = async () => {
    await uploaderRef.current?.pause();
  };

  const handleResume = async () => {
    if (!uploaderRef.current) return;
    try {
      const project = await uploaderRef.current.resume();
      onDeploymentStarted(project);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'UPLOAD_PAUSED') return;
      setSnapshot((prev) =>
        prev ? { ...prev, state: 'error', speedBytesPerSec: 0, errorMessage: msg } : null
      );
    }
  };

  const handleCancel = async () => {
    await uploaderRef.current?.cancel();
    uploaderRef.current = null;
    setSelectedFile(null);
    setSnapshot(null);
  };

  const handleRetry = async () => {
    if (uploaderRef.current && snapshot?.sessionId) {
      try {
        const project = await uploaderRef.current.retryFailed();
        onDeploymentStarted(project);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'UPLOAD_PAUSED') return;
        setSnapshot((prev) =>
          prev ? { ...prev, state: 'error', speedBytesPerSec: 0, errorMessage: msg } : null
        );
      }
    } else if (selectedFile) {
      await startFileUpload(selectedFile);
    }
  };

  const percent =
    snapshot && snapshot.totalBytes > 0
      ? Math.min(100, Math.round((snapshot.uploadedBytes / snapshot.totalBytes) * 100))
      : 0;

  const isBusy =
    snapshot?.state === 'hashing' ||
    snapshot?.state === 'uploading' ||
    snapshot?.state === 'verifying';

  return (
    <section aria-label="Upload ZIP workspace" className="w-full">
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        onChange={handleFileChange}
        className="sr-only"
      />

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`rounded-2xl border transition-colors p-6 sm:p-10 ${
          isDragging
            ? 'border-blue-600 bg-blue-50/70 dark:border-blue-500 dark:bg-blue-950/30'
            : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]'
        }`}
      >
        <div className="flex flex-col items-center text-center max-w-2xl mx-auto">
          <div className="w-14 h-14 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 flex items-center justify-center mb-5">
            <FileArchive className="w-7 h-7 text-blue-600 dark:text-blue-400" />
          </div>

          <h2 className="font-display text-xl sm:text-2xl font-bold text-slate-900 dark:text-slate-100 text-balance">
            Drop your website or web app ZIP here
          </h2>

          <p className="mt-2 text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed">
            Parallel multipart upload with adaptive chunking and SHA-256 verification. Supports nested folders and large archives up to{' '}
            <span className="font-mono font-medium text-slate-900 dark:text-slate-100 tabular-nums">
              {capabilities ? formatBytes(capabilities.effectiveMaxUploadBytes) : 'host capacity'}
            </span>
            .
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              disabled={isBusy}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center justify-center gap-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed px-7 py-3.5 text-base font-semibold text-white transition-colors min-h-[48px] whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Upload className="w-5 h-5" />
              Upload ZIP File
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            <span>
              Adaptive chunks:{' '}
              <strong className="font-mono text-slate-700 dark:text-slate-200 tabular-nums">
                {snapshot ? formatBytes(snapshot.chunkSizeBytes) : capabilities ? formatBytes(capabilities.chunkSizeBytes) : '4 MB'}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Storage:{' '}
              <strong className="text-slate-700 dark:text-slate-200">
                {capabilities?.storageDriver === 's3-multipart'
                  ? 'Direct S3 Multipart'
                  : 'Parallel Streaming Multipart'}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>No GitHub or CLI required</span>
          </div>
        </div>

        {snapshot && (
          <div className="mt-8 pt-6 border-t border-slate-200 dark:border-slate-800">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {snapshot.state === 'completed' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  ) : snapshot.state === 'error' ? (
                    <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
                  ) : (
                    <ShieldCheck className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
                  )}
                  <span className="truncate">{snapshot.filename}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                  <span>
                    {formatBytes(snapshot.uploadedBytes)} / {formatBytes(snapshot.totalBytes)} ({percent}%)
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Chunks {snapshot.completedChunks}/{snapshot.totalChunks} ({snapshot.concurrency}x parallel)
                  </span>
                  {snapshot.state === 'uploading' && snapshot.speedBytesPerSec > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{(snapshot.speedBytesPerSec / (1024 * 1024)).toFixed(2)} MB/s</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatDuration(snapshot.etaSeconds)}</span>
                    </>
                  )}
                  {snapshot.failedChunks > 0 && (
                    <span className="text-red-600 dark:text-red-400">
                      {snapshot.failedChunks} failed
                    </span>
                  )}
                  {snapshot.state === 'verifying' && <span>Verifying archive SHA-256 on server...</span>}
                  {snapshot.state === 'paused' && <span className="text-amber-600 dark:text-amber-400">Paused</span>}
                  {snapshot.state === 'completed' && (
                    <span className="text-emerald-600 dark:text-emerald-400">Upload verified</span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {snapshot.state === 'uploading' && (
                  <button
                    type="button"
                    onClick={handlePause}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors min-h-[40px] whitespace-nowrap"
                  >
                    <Pause className="w-3.5 h-3.5" />
                    Pause
                  </button>
                )}

                {snapshot.state === 'paused' && (
                  <button
                    type="button"
                    onClick={handleResume}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-700 transition-colors min-h-[40px] whitespace-nowrap"
                  >
                    <Play className="w-3.5 h-3.5" />
                    Resume
                  </button>
                )}

                {snapshot.state === 'error' && (
                  <button
                    type="button"
                    onClick={handleRetry}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-700 transition-colors min-h-[40px] whitespace-nowrap"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    {snapshot.sessionId ? 'Retry Failed Chunks' : 'Retry'}
                  </button>
                )}

                {snapshot.state !== 'completed' && (
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors min-h-[40px] whitespace-nowrap"
                  >
                    <X className="w-3.5 h-3.5" />
                    Cancel
                  </button>
                )}
              </div>
            </div>

            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <div
                className={`h-full transition-all duration-150 ${
                  snapshot.state === 'error'
                    ? 'bg-red-600'
                    : snapshot.state === 'paused'
                      ? 'bg-amber-500'
                      : snapshot.state === 'completed'
                        ? 'bg-emerald-600'
                        : 'bg-blue-600'
                }`}
                style={{ width: `${percent}%` }}
              />
            </div>

            {snapshot.errorMessage && (
              <p className="mt-3 text-xs text-red-600 dark:text-red-400">
                {snapshot.errorMessage}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
