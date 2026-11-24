# WAQAS ZIP TO WEB

**Upload ZIP. Build Website. Get Live Link.**

WAQAS ZIP TO WEB is an independent, full-stack web hosting and automated build platform that converts uploaded `.zip` archives into live, publicly accessible HTTPS websites without requiring GitHub, terminal access, or manual server setup.

## Features

- **Resumable Multipart ZIP Uploads**: Browser slices files into chunks with per-chunk SHA-256 integrity checks, pause/resume/cancel/retry controls, real-time upload speed and ETA, and automatic retry on connection drops.
- **Direct-to-Object-Storage Ready**: Supports presigned S3 / Cloudflare R2 / MinIO multipart uploads (`S3_BUCKET` configured) as well as zero-RAM-buffering streaming local multipart disk storage.
- **Automatic Project Detection**: Detects HTML/CSS/JS static sites, React, Vite, Next.js (static export & SSR), Node.js servers, Python web applications, and Dockerfiles—including nested ZIP wrapper folders.
- **Real Build Runner & Live Logs**: Executes `npm ci`/`npm install`, production builds, and isolated runtime processes while streaming live logs over Server-Sent Events (SSE).
- **Separated Public Hosting Architecture**: Strictly isolates private AI Studio preview origins (`ais-dev-*.run.app`) from public deployed websites. Integrates **Vercel** as the primary managed public provider for HTML/CSS/JS, built React & Vite SPAs, and Next.js (Static & SSR), alongside a public container runtime (`PUBLIC_BASE_DOMAIN` / `PUBLIC_HOSTING_URL`) for Node.js, Python, and Dockerfile server-side apps.
- **Unauthenticated External Verification**: Probes every deployed public URL without cookies or login credentials (verifying HTTP status and linked JS/CSS assets) before displaying a Live URL.
- **Security Defenses**: Path traversal confinement, symlink rejection, ZIP bomb compression-ratio & byte-count caps, workspace isolation tokens, and scrubbed child environment variables (main-app secrets are never exposed to uploaded code).
- **Installable PWA + Dual Theme**: Mobile-first responsive interface with Light/Dark themes, Web App Manifest, Service Worker, and offline connectivity alerts.

## Environment Variables

See `.env.example` for all configuration options:

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | Control-plane HTTP server port | `3000` |
| `VERCEL_TOKEN` | Primary managed public hosting token (HTML/CSS/JS, React, Vite, Next.js) | `""` |
| `VERCEL_TEAM_ID` | Optional Vercel Team ID for team-scoped deployments | `""` |
| `PUBLIC_BASE_DOMAIN` | Wildcard container domain (`<slug>.<domain>`) for all stacks incl. Node.js/Python/Docker | `""` |
| `PUBLIC_HOSTING_URL` | Dedicated unauthenticated Cloud Run / VPS HTTPS origin (never `ais-dev-*`) | `""` |
| `PUBLIC_SITES_PORT` | Optional dedicated HTTP listener port serving only deployed sites (no `/api/*`) | `0` |
| `APP_URL` | Runtime control-plane origin (private preview URLs are automatically blocked from public links) | `""` |
| `DATA_DIR` | Persistent directory for SQLite DB, uploads, workspaces, artifacts | `./data` |
| `MAX_UPLOAD_BYTES` | Maximum upload bytes (also bounded by actual free disk) | `5368709120` (5 GB) |
| `CHUNK_SIZE_BYTES` | Upload chunk size in bytes | `4194304` (4 MB) |
| `MAX_EXTRACT_BYTES` | Maximum uncompressed extraction limit (ZIP bomb guard) | `2147483648` (2 GB) |
| `MAX_EXTRACT_FILES` | Maximum files allowed per archive | `25000` |
| `BUILD_TIMEOUT_MS` | Timeout per install/build command | `300000` (5 min) |
| `APP_MEMORY_LIMIT_MB` | Memory limit passed to isolated Node.js child runtimes | `512` |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Optional S3/R2/MinIO direct multipart storage config | `""` |

## Local Installation & Running

```bash
npm install
npm run dev
```

Production build & start:

```bash
npm run build
npm start
```

## Self-Hosting with Docker, MinIO & Caddy

1. Point `A` records for `zip.yourdomain.com` and `*.sites.yourdomain.com` to your VPS IP.
2. Update `Caddyfile` with your domain and configure `.env` with `PUBLIC_BASE_DOMAIN=sites.yourdomain.com` and S3/MinIO credentials.
3. Ensure your S3/R2/MinIO bucket allows `PUT` CORS from your dashboard origin with `ETag` in `ExposeHeaders`.
4. Start the stack:

```bash
docker compose up -d --build
```

## Honest Infrastructure Notes

- Upload capacity is bounded by real available storage on `DATA_DIR` (or your configured S3/R2 bucket), never by artificial 50 MB / 100 MB caps.
- Dockerfile builds require a host with an active Docker daemon (`/var/run/docker.sock`).
- Python apps with third-party `requirements.txt` dependencies require `python3-pip` installed on the host (included in the provided `Dockerfile`). Standard-library Python web servers run natively without `pip`.
