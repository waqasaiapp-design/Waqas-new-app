import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Globe,
  HardDrive,
  Moon,
  Server,
  Shield,
  ShieldAlert,
  Sun,
} from 'lucide-react';
import { DeploymentMonitor } from './components/DeploymentMonitor.tsx';
import { DeploymentsList } from './components/DeploymentsList.tsx';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton.tsx';
import { PublicHostingSetup } from './components/PublicHostingSetup.tsx';
import { UploadWorkspace } from './components/UploadWorkspace.tsx';
import { useTheme } from './hooks/useTheme.ts';
import { formatBytes } from './lib/uploadClient.ts';
import type { HostCapabilities, ProjectRecord } from './types.ts';

interface SupportedStackItem {
  id: string;
  name: string;
  detection: string;
  execution: string;
}

const SUPPORTED_STACKS: SupportedStackItem[] = [
  {
    id: 'static',
    name: 'HTML, CSS & JavaScript',
    detection: 'Detects index.html or .html files',
    execution: 'Published directly to static HTTPS hosting',
  },
  {
    id: 'react',
    name: 'React',
    detection: 'Detects react / react-scripts in package.json',
    execution: 'Installs dependencies and builds production bundle',
  },
  {
    id: 'vite',
    name: 'Vite',
    detection: 'Detects vite in package.json or vite.config',
    execution: 'Compiles dist/ bundle configured for live routing',
  },
  {
    id: 'nextjs',
    name: 'Next.js',
    detection: 'Detects next in package.json',
    execution: 'Runs next build + static export or isolated SSR server',
  },
  {
    id: 'nodejs',
    name: 'Node.js Applications',
    detection: 'Detects scripts.start, server.js, or index.js',
    execution: 'Isolated process with allocated PORT and reverse proxy',
  },
  {
    id: 'python',
    name: 'Python Web Applications',
    detection: 'Detects app.py, main.py, server.py, or manage.py',
    execution: 'Runs WSGI/ASGI/HTTP server on allocated PORT',
  },
  {
    id: 'dockerfile',
    name: 'Dockerfile Projects',
    detection: 'Detects Dockerfile in project root',
    execution: 'Builds and runs isolated container when Docker daemon is active',
  },
];

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const [workspaceToken, setWorkspaceToken] = useState<string>('');
  const [capabilities, setCapabilities] = useState<HostCapabilities | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [loadingProjects, setLoadingProjects] = useState<boolean>(true);
  const [activeView, setActiveView] = useState<'workspace' | 'setup'>('workspace');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshCapabilities = useCallback(async () => {
    const res = await fetch('/api/capabilities');
    if (res.ok) {
      const caps = (await res.json()) as HostCapabilities;
      setCapabilities(caps);
    }
  }, []);

  const loadWorkspace = useCallback(async () => {
    try {
      const savedToken = (() => {
        try {
          return sessionStorage.getItem('waqas_ws_token') || '';
        } catch {
          return '';
        }
      })();

      const sessionRes = await fetch('/api/session', {
        headers: savedToken ? { 'X-Workspace-Token': savedToken } : {},
      });
      if (!sessionRes.ok) return;
      const sessionData = await sessionRes.json();
      const token = String(sessionData.workspaceToken || '');
      setWorkspaceToken(token);
      setCapabilities(sessionData.capabilities as HostCapabilities);

      try {
        sessionStorage.setItem('waqas_ws_token', token);
      } catch {
        // ignore
      }

      const projRes = await fetch('/api/projects', {
        headers: { 'X-Workspace-Token': token },
      });
      if (projRes.ok) {
        const projData = await projRes.json();
        const list = (projData.projects || []) as ProjectRecord[];
        setProjects(list);
        if (list.length > 0) {
          setActiveProjectId((prev) => prev ?? list[0].id);
        }
      }
    } finally {
      setLoadingProjects(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  const handleDeploymentStarted = (project: ProjectRecord) => {
    setProjects((prev) => [project, ...prev.filter((item) => item.id !== project.id)]);
    setActiveProjectId(project.id);
  };

  const handleProjectUpdated = useCallback((updated: ProjectRecord) => {
    setProjects((prev) => {
      const exists = prev.some((p) => p.id === updated.id);
      if (!exists) return [updated, ...prev];
      return prev.map((p) => (p.id === updated.id ? updated : p));
    });
  }, []);

  const handleDeleteProject = async (projectId: string) => {
    if (!workspaceToken) return;
    const res = await fetch(`/api/projects/${projectId}`, {
      method: 'DELETE',
      headers: { 'X-Workspace-Token': workspaceToken },
    });
    if (res.ok) {
      setProjects((prev) => {
        const next = prev.filter((p) => p.id !== projectId);
        if (activeProjectId === projectId) {
          setActiveProjectId(next[0]?.id ?? null);
        }
        return next;
      });
    }
  };

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-slate-900 dark:bg-[#090D16] dark:text-slate-100">
      {/* Three-Zone Top Bar */}
      <header className="sticky top-0 z-40 border-b border-slate-200 dark:border-slate-800 bg-[#F8FAFC]/95 dark:bg-[#090D16]/95 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          <a
            href="#upload"
            className="font-display text-base sm:text-lg font-extrabold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0"
          >
            WAQAS ZIP TO WEB
          </a>

          <nav
            aria-label="Primary navigation"
            className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-300"
          >
            <a
              href="#upload"
              onClick={() => setActiveView('workspace')}
              className="hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Upload
            </a>
            <a
              href="#deployments"
              onClick={() => setActiveView('workspace')}
              className="hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Deployments
            </a>
            <a
              href="#stacks"
              onClick={() => setActiveView('workspace')}
              className="hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Supported Stacks
            </a>
            <button
              type="button"
              onClick={() => setActiveView('setup')}
              className={`inline-flex items-center gap-1.5 hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeView === 'setup' ? 'text-blue-600 dark:text-blue-400 font-semibold' : ''
              }`}
            >
              <span>Hosting Setup</span>
              {capabilities && !capabilities.publicHostingReady && (
                <span className="h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" />
              )}
            </button>
          </nav>

          <div className="shrink-0">
            <button
              type="button"
              onClick={() => {
                setActiveView('workspace');
                setTimeout(() => fileInputRef.current?.click(), 0);
              }}
              className="inline-flex items-center justify-center rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-2 text-xs sm:text-sm font-semibold text-white transition-colors whitespace-nowrap shrink-0 min-h-[40px] cursor-pointer"
            >
              Upload ZIP
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-12">
        {activeView === 'setup' ? (
          <PublicHostingSetup
            capabilities={capabilities}
            onRefreshCapabilities={refreshCapabilities}
            onBackToWorkspace={() => setActiveView('workspace')}
          />
        ) : (
          <>
            {capabilities && !capabilities.publicHostingReady && (
              <div className="rounded-2xl border border-amber-300 dark:border-amber-800/70 bg-amber-50/80 dark:bg-amber-950/25 p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0">
                  <ShieldAlert className="w-5 h-5 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <div className="text-sm font-bold text-amber-900 dark:text-amber-200">
                      Public Hosting Credentials Required for External Live Links
                    </div>
                    <p className="text-xs sm:text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                      This workspace is running inside a private AI Studio preview proxy (<code>ais-dev-*.run.app</code>), which returns 403 Forbidden to other devices. Configure <code>VERCEL_TOKEN</code> in server environment secrets so deployed sites receive genuine unauthenticated HTTPS links.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveView('setup')}
                  className="inline-flex items-center justify-center rounded-xl bg-amber-600 hover:bg-amber-700 px-4 py-2.5 text-xs sm:text-sm font-semibold text-white transition-colors min-h-[42px] whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Open Public Hosting Setup
                </button>
              </div>
            )}
        {/* Hero & Utility Strip */}
        <section id="upload" className="space-y-6">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div className="max-w-2xl">
              <h1 className="font-display text-3xl sm:text-5xl font-extrabold tracking-tight text-slate-900 dark:text-white text-balance">
                Upload ZIP. Build Website. Get Live Link.
              </h1>
              <p className="mt-3 text-base sm:text-lg text-slate-600 dark:text-slate-300 leading-relaxed">
                Turn any website or web application ZIP archive into a real, publicly reachable HTTPS website without GitHub, terminals, or manual server setup.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <PWAInstallButton />
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors min-h-[40px] whitespace-nowrap cursor-pointer"
              >
                {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
              </button>
            </div>
          </div>

          <UploadWorkspace
            workspaceToken={workspaceToken}
            capabilities={capabilities}
            fileInputRef={fileInputRef}
            onDeploymentStarted={handleDeploymentStarted}
          />
        </section>

        {/* Active Build & Deployment Progress + Live URL */}
        {activeProject && (
          <DeploymentMonitor
            project={activeProject}
            workspaceToken={workspaceToken}
            onProjectUpdated={handleProjectUpdated}
            onOpenHostingSetup={() => setActiveView('setup')}
          />
        )}

        {/* Deployments History */}
        <section id="deployments" className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">
                Workspace Deployments
              </h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Isolated to your browser workspace. Public live URLs work from any device or network.
              </p>
            </div>
            <span className="font-mono text-xs text-slate-500 dark:text-slate-400 tabular-nums shrink-0">
              {projects.length} {projects.length === 1 ? 'project' : 'projects'}
            </span>
          </div>

          {loadingProjects ? (
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6 space-y-3">
              <div className="h-5 w-48 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
              <div className="h-4 w-72 rounded bg-slate-100 dark:bg-slate-800/70 animate-pulse" />
            </div>
          ) : (
            <DeploymentsList
              projects={projects}
              activeProjectId={activeProjectId}
              onSelectProject={(p) => setActiveProjectId(p.id)}
              onDeleteProject={handleDeleteProject}
            />
          )}
        </section>

        {/* Supported Project Types */}
        <section id="stacks" className="space-y-4">
          <div>
            <h2 className="font-display text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">
              Supported Project Types
            </h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Framework, root folder (including nested ZIP wrappers), dependencies, and build commands are detected automatically.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {SUPPORTED_STACKS.map((stack) => {
              const isDockerUnavailable =
                stack.id === 'dockerfile' && capabilities && !capabilities.runtimes.docker.daemonRunning;
              return (
                <div
                  key={stack.id}
                  className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                      {stack.name}
                    </h3>
                    {isDockerUnavailable ? (
                      <span className="text-xs font-medium text-amber-600 dark:text-amber-400 whitespace-nowrap">
                        Needs Docker Host
                      </span>
                    ) : (
                      <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                        Ready
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{stack.detection}</p>
                  <p className="mt-1 text-xs text-slate-700 dark:text-slate-300">{stack.execution}</p>
                </div>
              );
            })}
          </div>
        </section>

        {/* Real Infrastructure & Limits Disclosure */}
        <section id="infrastructure" className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">
                Host Infrastructure & Capacity
              </h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Live runtime telemetry, storage capacity, and self-hosting configuration.
              </p>
            </div>

            <a
              href="/api/system/source-zip"
              download="waqas-zip-to-web-source.zip"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors min-h-[40px] whitespace-nowrap shrink-0"
            >
              <Download className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              Download Complete Source ZIP
            </a>
          </div>

          {capabilities && (
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] divide-y divide-slate-200 dark:divide-slate-800">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-slate-200 dark:divide-slate-800">
                <div className="p-5">
                  <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                    {capabilities.publicHostingReady ? (
                      <Globe className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                    )}
                    <span>Public HTTPS Hosting</span>
                  </div>
                  <div
                    className={`mt-2 font-mono text-base font-bold ${
                      capabilities.publicHostingReady
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-amber-700 dark:text-amber-400'
                    }`}
                  >
                    {capabilities.publicHostingReady
                      ? capabilities.publicHostingProvider
                      : 'Blocked (Private Preview)'}
                  </div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 break-words">
                    {capabilities.publicHostingReady
                      ? `Origin: ${capabilities.publicHostingOrigin} (${capabilities.publicRoutingMode})`
                      : capabilities.isAiStudioPrivatePreview
                        ? 'Current host is an authenticated AI Studio preview proxy (403 to external visitors).'
                        : 'No public HTTPS hosting provider or custom domain configured.'}
                  </div>
                </div>

                <div className="p-5">
                  <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                    <HardDrive className="w-4 h-4" />
                    <span>Upload Storage Capacity</span>
                  </div>
                  <div className="mt-2 font-mono text-lg font-bold text-slate-900 dark:text-white tabular-nums">
                    {formatBytes(capabilities.effectiveMaxUploadBytes)}
                  </div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    {formatBytes(capabilities.diskAvailableBytes)} free of{' '}
                    {formatBytes(capabilities.diskTotalBytes)} ({capabilities.storageDriver})
                  </div>
                </div>

                <div className="p-5">
                  <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                    <Server className="w-4 h-4" />
                    <span>Installed Host Runtimes</span>
                  </div>
                  <div className="mt-2 space-y-1 text-xs font-mono text-slate-700 dark:text-slate-200">
                    <div>
                      Node: {capabilities.runtimes.node.version || 'unavailable'} · npm{' '}
                      {capabilities.runtimes.npm.version || 'unavailable'}
                    </div>
                    <div>
                      PMs:{' '}
                      {[
                        capabilities.runtimes.pnpm.available ? `pnpm ${capabilities.runtimes.pnpm.version}` : null,
                        capabilities.runtimes.yarn.available ? `yarn ${capabilities.runtimes.yarn.version}` : null,
                        capabilities.runtimes.bun.available ? `bun ${capabilities.runtimes.bun.version}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'npm'}
                    </div>
                    <div>
                      Python: {capabilities.runtimes.python3.version || 'unavailable'} · pip{' '}
                      {capabilities.runtimes.pip.available ? 'ready' : 'not installed'}
                    </div>
                    <div>
                      Docker:{' '}
                      {capabilities.runtimes.docker.daemonRunning
                        ? capabilities.runtimes.docker.version
                        : 'daemon unavailable'}
                    </div>
                  </div>
                </div>

                <div className="p-5">
                  <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                    <Shield className="w-4 h-4" />
                    <span>Security & Execution Limits</span>
                  </div>
                  <div className="mt-2 space-y-1 text-xs font-mono text-slate-700 dark:text-slate-200 tabular-nums">
                    <div>Max extract: {formatBytes(capabilities.maxExtractBytes)}</div>
                    <div>Max files/ZIP: {capabilities.maxExtractFiles.toLocaleString()}</div>
                    <div>
                      Memory cap: {capabilities.appMemoryLimitMb} MB · Timeout:{' '}
                      {Math.round(capabilities.buildTimeoutMs / 1000)}s
                    </div>
                  </div>
                </div>
              </div>

              {capabilities.missingExternalInfra.length > 0 && (
                <div className="p-5 space-y-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-400">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>Active Environment Notes & External Infrastructure</span>
                  </div>
                  <ul className="space-y-1.5 text-xs text-slate-600 dark:text-slate-300 list-disc list-inside">
                    {capabilities.missingExternalInfra.map((note, idx) => (
                      <li key={idx}>{note}</li>
                    ))}
                  </ul>
                </div>
              )}

              {capabilities.missingExternalInfra.length === 0 && (
                <div className="p-5 flex items-center gap-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>Full external public hosting, object storage, Docker daemon, and TLS are active.</span>
                </div>
              )}
            </div>
          )}
        </section>
          </>
        )}
      </main>

      <footer className="border-t border-slate-200 dark:border-slate-800 py-6">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400">
          <span className="font-display font-semibold text-slate-700 dark:text-slate-300">
            WAQAS ZIP TO WEB — Upload ZIP. Build Website. Get Live Link.
          </span>
          <div className="flex items-center gap-4">
            <a
              href="#upload"
              onClick={() => setActiveView('workspace')}
              className="hover:text-slate-900 dark:hover:text-slate-100"
            >
              Upload
            </a>
            <a
              href="#deployments"
              onClick={() => setActiveView('workspace')}
              className="hover:text-slate-900 dark:hover:text-slate-100"
            >
              Deployments
            </a>
            <button
              type="button"
              onClick={() => setActiveView('setup')}
              className="hover:text-slate-900 dark:hover:text-slate-100 cursor-pointer"
            >
              Hosting Setup
            </button>
            <a href="/api/system/source-zip" className="hover:text-slate-900 dark:hover:text-slate-100">
              Source ZIP
            </a>
          </div>
        </div>
      </footer>

      <OfflineIndicator />
    </div>
  );
}
