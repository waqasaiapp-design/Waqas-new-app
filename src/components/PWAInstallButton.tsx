import React, { useState } from 'react';
import { Download, Smartphone, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall.ts';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
      >
        <Download className="w-4 h-4 text-blue-600 dark:text-blue-400" />
        Install App
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
        >
          <Smartphone className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          Install on iOS
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
            <div className="w-full max-w-sm rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xl">
              <div className="flex items-center justify-between gap-4">
                <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  Install WAQAS ZIP TO WEB
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="Close install instructions"
                  className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <ol className="mt-4 space-y-2.5 text-sm text-slate-600 dark:text-slate-300 list-decimal list-inside">
                <li>
                  Tap the <span className="font-semibold text-slate-900 dark:text-slate-100">Share</span> button in Safari.
                </li>
                <li>
                  Scroll down and tap{' '}
                  <span className="font-semibold text-slate-900 dark:text-slate-100">Add to Home Screen</span>.
                </li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-5 w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-3.5 py-2 text-xs font-medium text-amber-900 dark:text-amber-100 shadow-lg"
    >
      <WifiOff className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
      <span>Offline — Waiting for network connection to resume uploads</span>
    </div>
  );
};
