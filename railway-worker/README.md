# Durable Viral+ / Edit+ worker

Background worker intended for Railway. It claims durable jobs from Supabase Postgres and processes video bytes from private Supabase Storage. Video files are never carried inside an invocation JSON payload.

## Current scope

- Claims `viral_analysis` jobs with `FOR UPDATE SKIP LOCKED`.
- Maintains lock/heartbeat state.
- Requeues stale jobs.
- Retries failures with exponential backoff.
- Streams the private source video to local ephemeral disk.
- Runs ffprobe + FFmpeg silence, scene-change and audio-level measurements.
- Uploads the source to Gemini Files.
- Produces evidence-backed semantic analysis.
- Computes the final Viral+ score in code.
- Persists the report and completes the durable job idempotently.
- Exposes `/health` on `PORT`.

Edit+ render jobs intentionally are not claimed yet. They will be added only after the analysis job path is stable.

## Required environment

- `DATABASE_URL`: Supabase Postgres/pooler connection string. Keep server-side only.
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`: server-side only.
- `GEMINI_API_KEY`: server-side only.

Optional:

- `GEMINI_MODEL=gemini-3.8-flash`
- `GEMINI_FALLBACK_MODEL=gemini-3.5-flash-lite`
- `RULEBOOK_VERSION=vp-editorial-2026-10`
- `POLL_MS=2500`
- `STALE_SECONDS=360`
- `DATABASE_SSL=false` for local Postgres only.

## Deploy

Railway should deploy this directory using its Dockerfile. The worker needs no public traffic except the lightweight health endpoint.

Do not place any secret in GitHub, frontend JavaScript, Vercel public env vars or Supabase client configuration.
