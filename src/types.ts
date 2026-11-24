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
  filename: string;
  total_size: number;
  chunk_size: number;
  total_chunks: number;
  uploaded_chunks: number[];
  sha256_expected: string | null;
  sha256_actual: string | null;
  storage_driver: 'local-multipart' | 's3-multipart';
  status: UploadStatus;
  bytes_received: number;
  created_at: number;
  updated_at: number;
}

export interface ProjectRecord {
  id: string;
  slug: string;
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

export interface HostCapabilities {
  storageDriver: 's3-multipart' | 'local-multipart';
  diskTotalBytes: number;
  diskAvailableBytes: number;
  memoryTotalBytes: number;
  memoryFreeBytes: number;
  effectiveMaxUploadBytes: number;
  chunkSizeBytes: number;
  maxChunkSizeBytes: number;
  maxExtractBytes: number;
  maxExtractFiles: number;
  buildTimeoutMs: number;
  appMemoryLimitMb: number;
  publicRoutingMode: 'subdomain-and-path' | 'path-only' | 'external-provider';
  publicBaseDomain: string;
  publicHostingProvider:
    | 'vercel'
    | 'wildcard-domain'
    | 'custom-public-host'
    | 'private-preview';
  publicHostingReady: boolean;
  publicHostingOrigin: string | null;
  isAiStudioPrivatePreview: boolean;
  publicHostingDiagnostic: string | null;
  hostingSetup: {
    primaryProviderName: string;
    primaryProviderReady: boolean;
    containerRuntimeName: string;
    containerRuntimeReady: boolean;
    controlPlaneOrigin: string | null;
    controlPlaneIsPrivatePreview: boolean;
    requiredSecrets: Array<{
      envVar: string;
      category: 'primary-provider' | 'container-runtime';
      required: boolean;
      requiredFor: string;
      configured: boolean;
      description: string;
      whereToGet: string;
    }>;
  };
  runtimes: {
    node: { available: boolean; version: string | null };
    npm: { available: boolean; version: string | null };
    pnpm: { available: boolean; version: string | null };
    yarn: { available: boolean; version: string | null };
    bun: { available: boolean; version: string | null };
    python3: { available: boolean; version: string | null };
    pip: { available: boolean; version: string | null };
    docker: { available: boolean; version: string | null; daemonRunning: boolean };
  };
  missingExternalInfra: string[];
}
