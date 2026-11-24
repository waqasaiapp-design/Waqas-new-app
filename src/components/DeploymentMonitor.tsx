import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  Lock,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Terminal,
} from 'lucide-react';
import type { BuildLogEntry, ProjectRecord, ProjectStatus } from '../types.ts';
import { formatBytes } from '../lib/uploadClient.ts';

interface DeploymentMonitorProps {
  project: ProjectRecord;
  workspaceToken: string;
  onProjectUpdated: (project: ProjectRecord) => void;
  onOpenHostingSetup?: () => void;
}

const PIPELINE_STEPS: Array<{ key: string; label: string }> = [
  { key: 'upload', label: 'Upload' },
  { key: 'extracting', label: 'Extract' },
  { key: 'detecting', label: 'Detect' },
  { key: 'installing', label: 'Install' },
  { key: 'building', label: 'Build' },
  { key: 'deploying', label: 'Deploy' },
  { key: 'live', label: 'Live' },
];

function getStepIndex(status: ProjectStatus): number {
  switch (status) {
    case 'queued':
      return 1;
    case 'extracting':
      return 1;
    case 'detecting':
      return 2;
    case 'installing':
      return 3;
    case 'building':
      return 4;
    case 'deploying':
      return 5;
    case 'live':
      return 6;
    case 'public_blocked':
      return 6;
    case 'stopped':
      return 6;
    case 'failed':
      return -1;
  }
}

export const DeploymentMonitor: React.FC<DeploymentMonitorProps> = ({
  project,
  workspaceToken,
  onProjectUpdated,
  onOpenHostingSetup,
}) => {
  const [logs, setLogs] = useState<BuildLogEntry[]>([]);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedLogs, setCopiedLogs] = useState(false);
  const [showOverrides, setShowOverrides] = useState(false);
  const [rootSubpath, setRootSubpath] = useState(project.root_subpath || '');
  const [installCmd, setInstallCmd] = useState(project.install_cmd || '');
  const [buildCmd, setBuildCmd] = useState(project.build_cmd || '');
  const [startCmd, setStartCmd] = useState(project.start_cmd || '');
  const [outputDir, setOutputDir] = useState(project.output_dir || '');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setRootSubpath(project.root_subpath || '');
    setInstallCmd(project.install_cmd || '');
    setBuildCmd(project.build_cmd || '');
    setStartCmd(project.start_cmd || '');
    setOutputDir(project.output_dir || '');
  }, [project.id, project.root_subpath, project.install_cmd, project.build_cmd, project.start_cmd, project.output_dir]);

  useEffect(() => {
    const abortController = new AbortController();
    setLogs([]);

    async function subscribeSSE() {
      try {
        const res = await fetch(`/api/projects/${project.id}/events`, {
          headers: { 'X-Workspace-Token': workspaceToken },
          signal: abortController.signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';
          for (const frame of frames) {
            const dataLines = frame
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim());
            if (dataLines.length === 0) continue;
            const raw = dataLines.join('\n');
            try {
              const evt = JSON.parse(raw);
              if (evt.type === 'init') {
                setLogs(evt.logs || []);
                if (evt.project) onProjectUpdated(evt.project);
              } else if (evt.type === 'log' && evt.log) {
                setLogs((prev) => {
                  if (prev.some((item) => item.seq === evt.log.seq)) return prev;
                  return [...prev, evt.log];
                });
              } else if (evt.type === 'status' && evt.project) {
                onProjectUpdated(evt.project);
              }
            } catch {
              // ignore heartbeat/malformed frame
            }
          }
        }
      } catch {
        // aborted or disconnected
      }
    }

    void subscribeSSE();
    return () => abortController.abort();
  }, [project.id, workspaceToken]);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs.length]);

  const handleCopyUrl = async () => {
    if (!project.live_url) return;
    try {
      await navigator.clipboard.writeText(project.live_url);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleCopyLogs = async () => {
    const text = logs.map((l) => `[${l.stage}] ${l.message}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopiedLogs(true);
      setTimeout(() => setCopiedLogs(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleRedeploy = async (withOverrides: boolean) => {
    setBusyAction('redeploy');
    setActionError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/redeploy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Token': workspaceToken,
        },
        body: JSON.stringify(
          withOverrides
            ? {
                overrides: {
                  rootSubpath: rootSubpath.trim(),
                  installCmd: installCmd.trim() || null,
                  buildCmd: buildCmd.trim() || null,
                  startCmd: startCmd.trim() || null,
                  outputDir: outputDir.trim() || null,
                },
              }
            : {}
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Redeploy failed');
      if (data.project) onProjectUpdated(data.project);
      setShowOverrides(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleRestart = async () => {
    setBusyAction('restart');
    setActionError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/restart`, {
        method: 'POST',
        headers: { 'X-Workspace-Token': workspaceToken },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Restart failed');
      if (data.project) onProjectUpdated(data.project);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleStop = async () => {
    setBusyAction('stop');
    setActionError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/stop`, {
        method: 'POST',
        headers: { 'X-Workspace-Token': workspaceToken },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Stop failed');
      if (data.project) onProjectUpdated(data.project);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleVerifyPublic = async () => {
    setBusyAction('verify');
    setActionError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/verify-public`, {
        method: 'POST',
        headers: { 'X-Workspace-Token': workspaceToken },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Public verification failed');
      if (data.project) onProjectUpdated(data.project);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const activeIdx = getStepIndex(project.status);
  const isInProgress = ['queued', 'extracting', 'detecting', 'installing', 'building', 'deploying'].includes(
    project.status
  );

  return (
    <section
      aria-label="Build and deployment progress"
      className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6 sm:p-8"
    >
      {/* Header Summary */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-6 border-b border-slate-200 dark:border-slate-800">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-mono font-medium text-slate-700 dark:text-slate-200">
              {project.framework === 'unknown' ? 'Detecting stack' : project.framework.toUpperCase()}
            </span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{project.file_count} files</span>
            {project.extracted_bytes > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{formatBytes(project.extracted_bytes)}</span>
              </>
            )}
            {project.build_duration_ms !== null && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  {(project.build_duration_ms / 1000).toFixed(1)}s
                </span>
              </>
            )}
          </div>
          <h3 className="mt-1 font-display text-xl font-bold text-slate-900 dark:text-slate-100 truncate">
            {project.name}
          </h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300 flex items-center gap-2">
            {isInProgress && <Loader2 className="w-4 h-4 text-blue-600 dark:text-blue-400 animate-spin shrink-0" />}
            {project.status === 'live' && (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            )}
            {project.status === 'public_blocked' && (
              <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
            )}
            {project.status === 'failed' && (
              <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
            )}
            <span>{project.stage_message}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {(project.status === 'live' || project.status === 'public_blocked') && project.start_cmd && (
            <>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={handleRestart}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors min-h-[40px] whitespace-nowrap"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Restart
              </button>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={handleStop}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors min-h-[40px] whitespace-nowrap"
              >
                <Square className="w-3.5 h-3.5" />
                Stop
              </button>
            </>
          )}

          {project.status === 'stopped' && (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={handleRestart}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors min-h-[40px] whitespace-nowrap"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Start Site
            </button>
          )}

          <button
            type="button"
            disabled={busyAction !== null || isInProgress}
            onClick={() => handleRedeploy(false)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors min-h-[40px] whitespace-nowrap"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            {project.status === 'failed' ? 'Retry Build' : 'Redeploy'}
          </button>

          <button
            type="button"
            onClick={() => setShowOverrides((s) => !s)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors min-h-[40px] whitespace-nowrap"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Build Settings
          </button>
        </div>
      </div>

      {/* Pipeline Step Indicator */}
      <div className="py-5 border-b border-slate-200 dark:border-slate-800">
        <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
          {PIPELINE_STEPS.map((step, idx) => {
            const done =
              project.status === 'live' ||
              (project.status === 'public_blocked' && idx < 6) ||
              (activeIdx > idx && activeIdx !== -1);
            const blockedStep = project.status === 'public_blocked' && idx === 6;
            const active = isInProgress && activeIdx === idx;
            const failed = project.status === 'failed' && idx > 0 && idx <= 5;
            return (
              <div key={step.key} className="flex flex-col items-start gap-1.5 min-w-0">
                <div
                  className={`h-1.5 w-full rounded-full transition-colors ${
                    done
                      ? 'bg-emerald-600 dark:bg-emerald-500'
                      : blockedStep
                        ? 'bg-amber-500 dark:bg-amber-400'
                        : active
                          ? 'bg-blue-600 dark:bg-blue-500'
                          : failed
                            ? 'bg-red-200 dark:bg-red-900/50'
                            : 'bg-slate-200 dark:bg-slate-800'
                  }`}
                />
                <span
                  className={`text-[11px] sm:text-xs font-medium truncate w-full ${
                    done
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : blockedStep
                        ? 'text-amber-700 dark:text-amber-400'
                        : active
                          ? 'text-blue-700 dark:text-blue-400'
                          : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  {blockedStep ? 'Blocked (403)' : step.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Externally Verified Live Public Website URL Box */}
      {project.status === 'live' && project.live_url && (
        <div className="mt-6 rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/70 dark:bg-emerald-950/25 p-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-emerald-800 dark:text-emerald-300">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                <span>Verified Public Website URL (No Login Required)</span>
                {project.hosting_provider && (
                  <span className="font-mono text-[11px] text-emerald-700 dark:text-emerald-400">
                    · {project.hosting_provider}
                  </span>
                )}
              </div>
              <a
                href={project.live_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 block font-mono text-sm sm:text-base font-medium text-slate-900 dark:text-white underline underline-offset-4 hover:text-blue-600 dark:hover:text-blue-400 truncate"
              >
                {project.live_url}
              </a>
              {project.public_verification && (
                <div className="mt-1.5 text-xs text-emerald-800/80 dark:text-emerald-300/80 tabular-nums">
                  External check passed: HTTP {project.public_verification.httpStatus} ·{' '}
                  {project.public_verification.assetsChecked} linked JS/CSS{' '}
                  {project.public_verification.assetsChecked === 1 ? 'asset' : 'assets'} verified
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={handleVerifyPublic}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-white dark:bg-slate-900 px-3.5 py-2.5 text-xs font-medium text-emerald-800 dark:text-emerald-200 hover:bg-emerald-50 dark:hover:bg-slate-800 transition-colors min-h-[42px] whitespace-nowrap"
              >
                <Globe className="w-3.5 h-3.5" />
                {busyAction === 'verify' ? 'Verifying...' : 'Re-verify Link'}
              </button>
              <button
                type="button"
                onClick={handleCopyUrl}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors min-h-[42px] whitespace-nowrap"
              >
                {copiedUrl ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                {copiedUrl ? 'Copied' : 'Copy Link'}
              </button>
              <a
                href={project.live_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 px-5 py-2.5 text-xs sm:text-sm font-semibold text-white transition-colors min-h-[42px] whitespace-nowrap"
              >
                Open Website
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Honest Public Access Blocked / HTTP 403 Disclosure Card */}
      {project.status === 'public_blocked' && (
        <div className="mt-6 rounded-xl border border-amber-300 dark:border-amber-800/70 bg-amber-50/80 dark:bg-amber-950/25 p-5 space-y-4">
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
            <div className="space-y-1.5 min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs font-bold text-amber-900 dark:text-amber-300">
                <ShieldAlert className="w-4 h-4 shrink-0" />
                <span>
                  Public Access Blocked (HTTP {project.public_verification?.httpStatus ?? 403} Forbidden)
                </span>
              </div>
              <p className="text-sm font-mono text-slate-900 dark:text-slate-100 break-words">
                {project.error_message ||
                  'External unauthenticated visitors cannot reach this environment without authentication.'}
              </p>
              {project.public_verification?.redirectChain &&
                project.public_verification.redirectChain.length > 0 && (
                  <p className="text-xs font-mono text-amber-900/80 dark:text-amber-300/80 break-all">
                    Unauthenticated probe trace: {project.public_verification.redirectChain.join(' -> ')}
                  </p>
                )}
              {project.error_hint && (
                <p className="pt-1 text-xs sm:text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                  {project.error_hint}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              {onOpenHostingSetup && (
                <button
                  type="button"
                  onClick={onOpenHostingSetup}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400 dark:border-amber-700 bg-white dark:bg-slate-900 px-4 py-2.5 text-xs font-semibold text-amber-900 dark:text-amber-200 hover:bg-amber-100/60 dark:hover:bg-slate-800 transition-colors min-h-[42px] whitespace-nowrap cursor-pointer"
                >
                  Open Public Hosting Setup
                </button>
              )}
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={handleVerifyPublic}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-60 px-4 py-2.5 text-xs font-semibold text-white transition-colors min-h-[42px] whitespace-nowrap cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${busyAction === 'verify' ? 'animate-spin' : ''}`} />
                {busyAction === 'verify' ? 'Checking...' : 'Re-verify & Publish Public URL'}
              </button>
            </div>
          </div>

          {project.preview_url && (
            <div className="pt-3 border-t border-amber-200/80 dark:border-amber-900/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300">
                <Lock className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
                <span>
                  <strong className="font-semibold">Owner Preview Only (Authenticated Session):</strong>{' '}
                  Your built site is healthy locally, but this link only opens inside your active developer session and returns 403 Forbidden on other devices.
                </span>
              </div>
              <a
                href={project.preview_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 dark:border-amber-700 bg-white dark:bg-slate-900 px-3.5 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-amber-100/60 dark:hover:bg-slate-800 transition-colors min-h-[38px] whitespace-nowrap shrink-0"
              >
                Open Owner Preview
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          )}
        </div>
      )}

      {/* Error & Actionable Solution */}
      {((project.status !== 'public_blocked' && project.error_message) || actionError) && (
        <div className="mt-6 rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/25 p-5">
          <div className="text-xs font-semibold text-red-800 dark:text-red-300">
            Build Error Details
          </div>
          <p className="mt-1 text-sm text-red-900 dark:text-red-200 font-mono">
            {actionError || project.error_message}
          </p>
          {project.status !== 'public_blocked' && project.error_hint && (
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
              Recommended fix: {project.error_hint}
            </p>
          )}
        </div>
      )}

      {/* Optional Override Settings (Shown only on request / retry) */}
      {showOverrides && (
        <div className="mt-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-5">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Optional Build & Start Overrides
          </h4>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Auto-detected settings work for most projects. Adjust only if your archive uses custom scripts or folders.
          </p>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Project Root Subfolder
              <input
                type="text"
                value={rootSubpath}
                onChange={(e) => setRootSubpath(e.target.value)}
                placeholder="e.g. frontend or leave blank"
                className="mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Static Output Directory
              <input
                type="text"
                value={outputDir}
                onChange={(e) => setOutputDir(e.target.value)}
                placeholder="e.g. dist, build, out, or ."
                className="mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Install Command
              <input
                type="text"
                value={installCmd}
                onChange={(e) => setInstallCmd(e.target.value)}
                placeholder="e.g. npm install"
                className="mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Build Command
              <input
                type="text"
                value={buildCmd}
                onChange={(e) => setBuildCmd(e.target.value)}
                placeholder="e.g. npm run build"
                className="mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 sm:col-span-2">
              Start Command (for Node.js / Python / Next.js SSR)
              <input
                type="text"
                value={startCmd}
                onChange={(e) => setStartCmd(e.target.value)}
                placeholder="e.g. node server.js or python3 app.py"
                className="mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
              />
            </label>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowOverrides(false)}
              className="rounded-lg border border-slate-200 dark:border-slate-700 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => handleRedeploy(true)}
              className="rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-xs font-semibold text-white"
            >
              Apply & Rebuild
            </button>
          </div>
        </div>
      )}

      {/* Real-Time Build & Deployment Logs */}
      <div className="mt-6">
        <div className="flex items-center justify-between gap-2 mb-2.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300">
            <Terminal className="w-4 h-4 text-slate-500" />
            <span>Build & Deployment Logs</span>
          </div>
          <button
            type="button"
            onClick={handleCopyLogs}
            className="text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
            {copiedLogs ? 'Copied logs' : 'Copy logs'}
          </button>
        </div>

        <div
          ref={logContainerRef}
          className="h-64 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-200"
        >
          {logs.length === 0 ? (
            <div className="text-slate-500">Waiting for build worker output...</div>
          ) : (
            logs.map((entry) => (
              <div key={entry.seq} className="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-3 py-1 border-b border-slate-900/60 last:border-b-0">
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-slate-500 select-none tabular-nums">
                    {new Date(entry.created_at).toLocaleTimeString([], {
                      hour12: false,
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                  <span
                    className={`sm:w-16 ${
                      entry.level === 'error' || entry.level === 'stderr'
                        ? 'text-red-400'
                        : entry.level === 'success'
                          ? 'text-emerald-400'
                          : 'text-blue-400'
                    }`}
                  >
                    [{entry.stage}]
                  </span>
                </div>
                <span
                  className={`min-w-0 break-words whitespace-pre-wrap ${
                    entry.level === 'error'
                      ? 'text-red-300'
                      : entry.level === 'success'
                        ? 'text-emerald-300'
                        : 'text-slate-200'
                  }`}
                >
                  {entry.message}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
};
