import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FolderOpen,
  Loader2,
  PauseCircle,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import type { ProjectRecord } from '../types.ts';
import { formatBytes } from '../lib/uploadClient.ts';

interface DeploymentsListProps {
  projects: ProjectRecord[];
  activeProjectId: string | null;
  onSelectProject: (project: ProjectRecord) => void;
  onDeleteProject: (projectId: string) => void;
}

export const DeploymentsList: React.FC<DeploymentsListProps> = ({
  projects,
  activeProjectId,
  onSelectProject,
  onDeleteProject,
}) => {
  if (projects.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-8 text-center">
        <FolderOpen className="w-8 h-8 mx-auto text-slate-400" />
        <h3 className="mt-3 text-base font-semibold text-slate-900 dark:text-slate-100">
          No deployments yet
        </h3>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Upload a ZIP archive above to build and publish your first live website.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]">
      <div className="divide-y divide-slate-200 dark:divide-slate-800">
        {projects.map((p) => {
          const isSelected = p.id === activeProjectId;
          const isBuilding = ['queued', 'extracting', 'detecting', 'installing', 'building', 'deploying'].includes(
            p.status
          );

          return (
            <div
              key={p.id}
              className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-5 py-4 transition-colors ${
                isSelected
                  ? 'bg-blue-50/50 dark:bg-blue-950/20'
                  : 'hover:bg-slate-50 dark:hover:bg-slate-900/50'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectProject(p)}
                className="text-left min-w-0 flex-1 cursor-pointer"
              >
                <div className="flex items-center gap-2.5">
                  {p.status === 'live' && (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  )}
                  {p.status === 'public_blocked' && (
                    <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                  )}
                  {p.status === 'failed' && (
                    <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
                  )}
                  {p.status === 'stopped' && (
                    <PauseCircle className="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" />
                  )}
                  {isBuilding && (
                    <Loader2 className="w-4 h-4 text-blue-600 dark:text-blue-400 animate-spin shrink-0" />
                  )}
                  <span className="font-semibold text-sm text-slate-900 dark:text-slate-100 truncate">
                    {p.name}
                  </span>
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-mono">{p.framework}</span>
                  <span aria-hidden="true">·</span>
                  <span className="capitalize">
                    {p.status === 'public_blocked' ? 'Public Blocked (403)' : p.status}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{p.file_count} files</span>
                  {p.extracted_bytes > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">{formatBytes(p.extracted_bytes)}</span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">
                    {new Date(p.created_at).toLocaleString()}
                  </span>
                </div>
              </button>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => onSelectProject(p)}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 min-h-[36px] whitespace-nowrap"
                >
                  Inspect Logs
                </button>

                {p.status === 'live' && p.live_url && (
                  <a
                    href={p.live_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white min-h-[36px] whitespace-nowrap"
                  >
                    Open
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}

                <button
                  type="button"
                  onClick={() => onDeleteProject(p.id)}
                  aria-label={`Delete ${p.name}`}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 p-2 text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 min-h-[36px]"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
