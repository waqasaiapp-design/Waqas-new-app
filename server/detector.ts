import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ProjectFramework } from './db.ts';

export type PackageManagerName = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface DetectedProjectConfig {
  framework: ProjectFramework;
  packageManager: PackageManagerName | null;
  lockfile: string | null;
  enginesNode: string | null;
  hasPrepackagedNodeModules: boolean;
  installCmd: string | null;
  buildCmd: string | null;
  startCmd: string | null;
  outputDir: string | null;
  isStaticSite: boolean;
  reason: string;
}

interface PackageJsonShape {
  name?: string;
  packageManager?: string;
  engines?: { node?: string };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  main?: string;
  type?: string;
}

function detectPackageManager(
  fileNamesLower: Map<string, string>,
  pkg: PackageJsonShape
): { pm: PackageManagerName; lockfile: string | null } {
  if (fileNamesLower.has('pnpm-lock.yaml')) {
    return { pm: 'pnpm', lockfile: fileNamesLower.get('pnpm-lock.yaml')! };
  }
  if (fileNamesLower.has('yarn.lock')) {
    return { pm: 'yarn', lockfile: fileNamesLower.get('yarn.lock')! };
  }
  if (fileNamesLower.has('bun.lock') || fileNamesLower.has('bun.lockb')) {
    return {
      pm: 'bun',
      lockfile: (fileNamesLower.get('bun.lock') || fileNamesLower.get('bun.lockb'))!,
    };
  }
  if (fileNamesLower.has('package-lock.json')) {
    return { pm: 'npm', lockfile: fileNamesLower.get('package-lock.json')! };
  }

  const declared = (pkg.packageManager || '').toLowerCase();
  if (declared.startsWith('pnpm@')) return { pm: 'pnpm', lockfile: null };
  if (declared.startsWith('yarn@')) return { pm: 'yarn', lockfile: null };
  if (declared.startsWith('bun@')) return { pm: 'bun', lockfile: null };

  return { pm: 'npm', lockfile: null };
}

function buildInstallCommand(pm: PackageManagerName, lockfile: string | null): string {
  switch (pm) {
    case 'pnpm':
      return lockfile ? 'pnpm install --frozen-lockfile' : 'pnpm install';
    case 'yarn':
      return lockfile ? 'yarn install --frozen-lockfile' : 'yarn install';
    case 'bun':
      return lockfile ? 'bun install --frozen-lockfile' : 'bun install';
    case 'npm':
    default:
      return lockfile ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund';
  }
}

function buildRunScriptCommand(pm: PackageManagerName, scriptName: string): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm run ${scriptName}`;
    case 'yarn':
      return `yarn ${scriptName}`;
    case 'bun':
      return `bun run ${scriptName}`;
    case 'npm':
    default:
      return scriptName === 'start' ? 'npm start' : `npm run ${scriptName}`;
  }
}

export async function detectProjectFramework(
  projectRootDir: string,
  slug: string
): Promise<DetectedProjectConfig> {
  const entries = await fsp.readdir(projectRootDir, { withFileTypes: true });
  const fileNamesLower = new Map<string, string>();
  for (const e of entries) {
    if (e.isFile()) {
      fileNamesLower.set(e.name.toLowerCase(), e.name);
    }
  }

  // 1. Check Dockerfile
  if (fileNamesLower.has('dockerfile')) {
    const dockerFileName = fileNamesLower.get('dockerfile')!;
    return {
      framework: 'dockerfile',
      packageManager: null,
      lockfile: null,
      enginesNode: null,
      hasPrepackagedNodeModules: false,
      installCmd: null,
      buildCmd: `docker build -f ${dockerFileName} -t waqas-site-${slug} .`,
      startCmd: `docker run -d --name waqas-run-${slug} -p 127.0.0.1:{{PORT}}:3000 waqas-site-${slug}`,
      outputDir: null,
      isStaticSite: false,
      reason: `Detected ${dockerFileName} in project root.`,
    };
  }

  // 2. Check package.json (Next.js, Full-stack Node+Vite, Vite, React, Node.js)
  if (fileNamesLower.has('package.json')) {
    const pkgPath = path.join(projectRootDir, fileNamesLower.get('package.json')!);
    let pkg: PackageJsonShape = {};
    try {
      pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8')) as PackageJsonShape;
    } catch {
      throw new Error('Found package.json, but it contains invalid JSON syntax.');
    }

    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const scripts = pkg.scripts || {};
    const hasNodeModules = fs.existsSync(path.join(projectRootDir, 'node_modules'));
    const hasDeps = Object.keys(allDeps).length > 0;
    const { pm, lockfile } = detectPackageManager(fileNamesLower, pkg);
    const enginesNode = pkg.engines?.node ? String(pkg.engines.node) : null;

    const installCmd = hasDeps ? buildInstallCommand(pm, lockfile) : null;

    // 2a. Next.js
    if ('next' in allDeps) {
      const nextConfigText = await readFirstExisting(projectRootDir, [
        'next.config.ts',
        'next.config.mjs',
        'next.config.js',
      ]);
      const isStaticExport = /output\s*:\s*['"]export['"]/.test(nextConfigText);
      const buildScript = scripts.build ? buildRunScriptCommand(pm, 'build') : 'npx next build';

      if (isStaticExport) {
        return {
          framework: 'nextjs',
          packageManager: pm,
          lockfile,
          enginesNode,
          hasPrepackagedNodeModules: hasNodeModules,
          installCmd,
          buildCmd: buildScript,
          startCmd: null,
          outputDir: 'out',
          isStaticSite: true,
          reason: `Detected Next.js static export (output: "export", PM: ${pm}${lockfile ? `, ${lockfile}` : ''}).`,
        };
      }

      return {
        framework: 'nextjs',
        packageManager: pm,
        lockfile,
        enginesNode,
        hasPrepackagedNodeModules: hasNodeModules,
        installCmd,
        buildCmd: buildScript,
        startCmd: scripts.start
          ? `${buildRunScriptCommand(pm, 'start')} -- --hostname 127.0.0.1 --port {{PORT}}`
          : 'npx next start --hostname 127.0.0.1 --port {{PORT}}',
        outputDir: '.next',
        isStaticSite: false,
        reason: `Detected Next.js server application (PM: ${pm}${lockfile ? `, ${lockfile}` : ''}).`,
      };
    }

    // 2b. Full-stack Node.js + Vite/Express (e.g., Express server serving Vite frontend + APIs)
    const serverEntry = ['server.ts', 'server.js', 'app.ts', 'app.js'].find((f) =>
      fileNamesLower.has(f)
    );
    const hasBackendFramework = ['express', 'fastify', 'koa', 'hono', '@nestjs/core'].some(
      (dep) => dep in allDeps
    );
    const hasProdStartScript = Boolean(scripts['start:prod']) || Boolean(scripts.start && !scripts.start.includes('vite'));
    if (hasBackendFramework && (hasProdStartScript || serverEntry)) {
      const startScriptCmd = scripts['start:prod']
        ? buildRunScriptCommand(pm, 'start:prod')
        : scripts.start && !scripts.start.includes('vite')
          ? buildRunScriptCommand(pm, 'start')
          : serverEntry
            ? serverEntry.endsWith('.ts')
              ? `npx tsx ${serverEntry}`
              : `node ${serverEntry}`
            : pkg.main
              ? `node ${pkg.main}`
              : null;

      if (startScriptCmd) {
        return {
          framework: 'nodejs',
          packageManager: pm,
          lockfile,
          enginesNode,
          hasPrepackagedNodeModules: hasNodeModules,
          installCmd,
          buildCmd: scripts.build ? buildRunScriptCommand(pm, 'build') : null,
          startCmd: startScriptCmd,
          outputDir: null,
          isStaticSite: false,
          reason: `Detected full-stack Node.js server (${serverEntry || 'scripts.start'}, PM: ${pm}${lockfile ? `, ${lockfile}` : ''}).`,
        };
      }
    }

    // 2c. Vite (React / Vue / Svelte / Vanilla Vite static SPA)
    if (
      'vite' in allDeps ||
      fileNamesLower.has('vite.config.ts') ||
      fileNamesLower.has('vite.config.js') ||
      fileNamesLower.has('vite.config.mjs')
    ) {
      const outDir = fs.existsSync(path.join(projectRootDir, 'build')) && !scripts.build
        ? 'build'
        : 'dist';
      return {
        framework: 'vite',
        packageManager: pm,
        lockfile,
        enginesNode,
        hasPrepackagedNodeModules: hasNodeModules,
        installCmd,
        buildCmd: scripts.build ? buildRunScriptCommand(pm, 'build') : 'npx vite build',
        startCmd: null,
        outputDir: outDir,
        isStaticSite: true,
        reason: `Detected Vite project (PM: ${pm}${lockfile ? `, ${lockfile}` : ''}).`,
      };
    }

    // 2d. React (Create React App or custom React bundle)
    if ('react-scripts' in allDeps || ('react' in allDeps && scripts.build && !scripts.start?.includes('node '))) {
      const outDir = 'react-scripts' in allDeps ? 'build' : 'dist';
      return {
        framework: 'react',
        packageManager: pm,
        lockfile,
        enginesNode,
        hasPrepackagedNodeModules: hasNodeModules,
        installCmd,
        buildCmd: scripts.build ? buildRunScriptCommand(pm, 'build') : null,
        startCmd: null,
        outputDir: outDir,
        isStaticSite: true,
        reason: `Detected React frontend project (PM: ${pm}${lockfile ? `, ${lockfile}` : ''}).`,
      };
    }

    // 2e. Node.js backend / full-stack application
    const entryCandidate = ['server.js', 'index.js', 'app.js', 'main.js', 'server.ts', 'index.ts'].find(
      (f) => fileNamesLower.has(f)
    );
    const startCmd = scripts['start:prod']
      ? buildRunScriptCommand(pm, 'start:prod')
      : scripts.start
        ? buildRunScriptCommand(pm, 'start')
        : entryCandidate
          ? entryCandidate.endsWith('.ts')
            ? `npx tsx ${entryCandidate}`
            : `node ${entryCandidate}`
          : pkg.main
            ? `node ${pkg.main}`
            : null;

    if (startCmd) {
      return {
        framework: 'nodejs',
        packageManager: pm,
        lockfile,
        enginesNode,
        hasPrepackagedNodeModules: hasNodeModules,
        installCmd,
        buildCmd: scripts.build ? buildRunScriptCommand(pm, 'build') : null,
        startCmd,
        outputDir: null,
        isStaticSite: false,
        reason: `Detected Node.js application (${scripts.start ? 'scripts.start' : entryCandidate || pkg.main}, PM: ${pm}${lockfile ? `, ${lockfile}` : ''}).`,
      };
    }
  }

  // 3. Check Python web applications
  const pythonEntry = ['app.py', 'main.py', 'server.py', 'wsgi.py', 'asgi.py', 'manage.py'].find(
    (f) => fileNamesLower.has(f)
  );
  const hasReqs = fileNamesLower.has('requirements.txt');
  const hasPyproject = fileNamesLower.has('pyproject.toml');
  if (pythonEntry || hasReqs || hasPyproject) {
    const installCmd = hasReqs ? 'python3 -m pip install -r requirements.txt' : null;
    let startCmd: string | null = null;
    if (pythonEntry === 'manage.py') {
      startCmd = 'python3 manage.py runserver 127.0.0.1:{{PORT}}';
    } else if (pythonEntry) {
      const content = await fsp.readFile(path.join(projectRootDir, pythonEntry), 'utf8').catch(() => '');
      if (/FastAPI\s*\(/.test(content)) {
        const mod = pythonEntry.replace(/\.py$/, '');
        startCmd = `python3 -m uvicorn ${mod}:app --host 127.0.0.1 --port {{PORT}}`;
      } else {
        startCmd = `python3 ${pythonEntry}`;
      }
    }
    return {
      framework: 'python',
      packageManager: null,
      lockfile: hasReqs ? 'requirements.txt' : hasPyproject ? 'pyproject.toml' : null,
      enginesNode: null,
      hasPrepackagedNodeModules: false,
      installCmd,
      buildCmd: null,
      startCmd,
      outputDir: null,
      isStaticSite: false,
      reason: `Detected Python web application (${pythonEntry || 'requirements.txt'}).`,
    };
  }

  // 4. Static HTML/CSS/JS site
  if (fileNamesLower.has('index.html') || Array.from(fileNamesLower.keys()).some((f) => f.endsWith('.html'))) {
    return {
      framework: 'static',
      packageManager: null,
      lockfile: null,
      enginesNode: null,
      hasPrepackagedNodeModules: false,
      installCmd: null,
      buildCmd: null,
      startCmd: null,
      outputDir: '.',
      isStaticSite: true,
      reason: 'Detected static HTML/CSS/JS website.',
    };
  }

  // 5. Standalone Node JS without package.json
  const jsEntry = ['server.js', 'index.js', 'app.js'].find((f) => fileNamesLower.has(f));
  if (jsEntry) {
    return {
      framework: 'nodejs',
      packageManager: null,
      lockfile: null,
      enginesNode: null,
      hasPrepackagedNodeModules: false,
      installCmd: null,
      buildCmd: null,
      startCmd: `node ${jsEntry}`,
      outputDir: null,
      isStaticSite: false,
      reason: `Detected standalone Node.js entry file (${jsEntry}).`,
    };
  }

  throw new Error(
    'Could not automatically detect a supported web project (expected index.html, package.json, Python entry script, or Dockerfile).'
  );
}

async function readFirstExisting(dir: string, names: string[]): Promise<string> {
  for (const name of names) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      return await fsp.readFile(p, 'utf8').catch(() => '');
    }
  }
  return '';
}
