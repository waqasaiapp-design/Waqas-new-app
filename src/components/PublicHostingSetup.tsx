import React, { useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Globe,
  KeyRound,
  Lock,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import type { HostCapabilities } from '../types.ts';

interface PublicHostingSetupProps {
  capabilities: HostCapabilities | null;
  onRefreshCapabilities: () => Promise<void>;
  onBackToWorkspace: () => void;
}

const STACK_ROUTING_ROWS = [
  {
    stack: 'HTML, CSS & JavaScript',
    runtime: 'Vercel Static Edge CDN (or Public Container Host)',
    howItDeploys: 'Publishes static files directly to an unauthenticated https://*.vercel.app/ URL.',
  },
  {
    stack: 'React & Vite Applications',
    runtime: 'Vercel Static Edge CDN (or Public Container Host)',
    howItDeploys: 'Builds production dist/ or build/ output with --base=/ and SPA fallback routing.',
  },
  {
    stack: 'Next.js (Static Export & SSR)',
    runtime: 'Vercel Next.js Runtime (or Public Container Host)',
    howItDeploys: 'Static exports publish out/; SSR apps deploy to Vercel Next.js server-side runtime.',
  },
  {
    stack: 'Node.js, Python & Dockerfile',
    runtime: 'Public Container / Cloud Run / Docker VPS',
    howItDeploys: 'Runs long-lived server processes on isolated ports behind PUBLIC_BASE_DOMAIN or PUBLIC_HOSTING_URL.',
  },
];

export const PublicHostingSetup: React.FC<PublicHostingSetupProps> = ({
  capabilities,
  onRefreshCapabilities,
  onBackToWorkspace,
}) => {
  const [refreshing, setRefreshing] = useState(false);

  const handleRecheck = async () => {
    setRefreshing(true);
    try {
      await onRefreshCapabilities();
    } finally {
      setRefreshing(false);
    }
  };

  const setup = capabilities?.hostingSetup;

  return (
    <section aria-label="Public Hosting Infrastructure Setup" className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <button
            type="button"
            onClick={onBackToWorkspace}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Upload & Deploy
          </button>
          <h1 className="mt-2 font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white">
            Public Hosting Setup & Environment Separation
          </h1>
          <p className="mt-1.5 text-sm sm:text-base text-slate-600 dark:text-slate-300 max-w-3xl">
            WAQAS ZIP TO WEB strictly separates your private AI Studio preview dashboard from external public website URLs so deployed sites never return 403 Forbidden.
          </p>
        </div>

        <button
          type="button"
          onClick={handleRecheck}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-60 px-4 py-2.5 text-xs sm:text-sm font-semibold text-white transition-colors min-h-[42px] whitespace-nowrap shrink-0 cursor-pointer"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Checking Server...' : 'Re-check Server Credentials'}
        </button>
      </div>

      {/* Environment Separation Architecture */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6 space-y-2.5">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            <Lock className="w-4 h-4 text-amber-600 dark:text-amber-400" />
            <span>1. Control Plane & Preview Host (Private)</span>
          </div>
          <div className="font-mono text-xs sm:text-sm text-slate-900 dark:text-slate-100 break-all">
            {setup?.controlPlaneOrigin || 'Current server session'}
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            {setup?.controlPlaneIsPrivatePreview
              ? 'This host is a private Google AI Studio preview proxy requiring Google login. WAQAS ZIP TO WEB blocks issuing ais-dev-*.run.app URLs as public website links.'
              : 'Runs the upload API, build worker, and workspace dashboard.'}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6 space-y-2.5">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            {capabilities?.publicHostingReady ? (
              <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400" />
            )}
            <span>2. External Public Deployment Environment</span>
          </div>
          <div
            className={`font-mono text-sm font-bold ${
              capabilities?.publicHostingReady
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-amber-700 dark:text-amber-400'
            }`}
          >
            {capabilities?.publicHostingReady
              ? `Active: ${capabilities.publicHostingProvider} (${capabilities.publicHostingOrigin})`
              : 'Credentials Missing — Public URL Publishing Paused'}
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            Primary Managed Provider: <strong>Vercel</strong> (Static, React, Vite, Next.js Static &amp; SSR). Container Runtime: <strong>Public Cloud Run / Docker Host</strong> (Node.js, Python, Dockerfile).
          </p>
        </div>
      </div>

      {/* Required Backend Secrets Checklist */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <h2 className="font-display text-base sm:text-lg font-bold text-slate-900 dark:text-white">
              Required Backend Environment Secrets
            </h2>
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Configure in server Secrets / .env only — never paste tokens into chat or browser code
          </span>
        </div>

        <div className="divide-y divide-slate-200 dark:divide-slate-800">
          {(setup?.requiredSecrets || []).map((item) => (
            <div
              key={item.envVar}
              className="p-5 sm:px-6 flex flex-col md:flex-row md:items-center justify-between gap-4"
            >
              <div className="space-y-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2.5">
                  <code className="font-mono text-sm font-bold text-slate-900 dark:text-white">
                    {item.envVar}
                  </code>
                  <span
                    className={`inline-flex items-center gap-1 text-xs font-semibold ${
                      item.configured
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : item.required
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    {item.configured ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Configured in Server Env
                      </>
                    ) : item.required ? (
                      <>
                        <ShieldAlert className="w-3.5 h-3.5" />
                        Required for Managed Public URLs
                      </>
                    ) : (
                      'Optional / Container Apps'
                    )}
                  </span>
                </div>
                <p className="text-xs text-slate-700 dark:text-slate-300">
                  <strong>Supports:</strong> {item.requiredFor}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {item.description} Source: <span className="font-medium">{item.whereToGet}</span>
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Where & How to Configure Steps */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6 space-y-3">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
            <Globe className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span>Step 1 — Configure Primary Provider (Vercel)</span>
          </div>
          <ol className="list-decimal list-inside space-y-2 text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
            <li>
              Sign in to Vercel and open <strong>Account Settings → Tokens → Create Token</strong>.
            </li>
            <li>
              Open the <strong>Secrets / Environment Variables</strong> panel in Google AI Studio (or your server <code>.env</code> file).
            </li>
            <li>
              Add secret <code>VERCEL_TOKEN</code> (and optional <code>VERCEL_TEAM_ID</code> if using a Vercel Team). Never expose it as a <code>VITE_</code> variable.
            </li>
            <li>
              Ensure Vercel Project <strong>Deployment Protection</strong> is disabled for production URLs so Android, iPhone, and desktop browsers open links without login.
            </li>
          </ol>
        </div>

        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6 space-y-3">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
            <Server className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            <span>Step 2 — Server-Side Runtime (Node.js, Python & Docker)</span>
          </div>
          <ol className="list-decimal list-inside space-y-2 text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
            <li>
              Persistent Node.js, Python, and Dockerfile apps need a real container host rather than a static CDN.
            </li>
            <li>
              Deploy WAQAS ZIP TO WEB using the included <code>Dockerfile</code> + <code>docker-compose.yml</code> + <code>Caddyfile</code> to Cloud Run (<code>--allow-unauthenticated</code>) or a Linux VPS.
            </li>
            <li>
              Set <code>PUBLIC_BASE_DOMAIN=sites.yourdomain.com</code> (or <code>PUBLIC_HOSTING_URL=https://deploy.yourdomain.com</code>) in backend environment variables.
            </li>
            <li>
              Optionally set <code>PUBLIC_SITES_PORT</code> to expose only deployed websites on a dedicated reverse-proxy port separate from <code>/api/*</code>.
            </li>
          </ol>
        </div>
      </div>

      {/* Stack Routing Matrix */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
            Supported Project Routing Architecture
          </h2>
        </div>
        <div className="divide-y divide-slate-200 dark:divide-slate-800">
          {STACK_ROUTING_ROWS.map((row) => (
            <div
              key={row.stack}
              className="px-6 py-4 grid grid-cols-1 md:grid-cols-3 gap-2 text-xs sm:text-sm"
            >
              <div className="font-semibold text-slate-900 dark:text-slate-100">{row.stack}</div>
              <div className="font-mono text-xs text-blue-700 dark:text-blue-400">{row.runtime}</div>
              <div className="text-slate-600 dark:text-slate-300">{row.howItDeploys}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};
