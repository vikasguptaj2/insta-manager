# InstaOps v2.0 n8n Automation Package

This directory contains the 5 hardened workflow definitions (`01`–`05`), Google Sheets schema definition, credential/n8n v2 setup instructions, and webhook execution contracts for **InstaOps v2.0**.

## Workflows (`n8n/workflows/`)

| File | Role | Trigger | Default State | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `01-extract-upload.json` | W01 | `POST /webhook/instaops-extract-v1` | Inactive | Transfers canonical `post:<uuid>` lock, validates `ok=true && status='ready'` + non-expired HTTPS downloader output, uploads to Cloudinary with partial checkpoints, and finalizes via `instaops_finalize_extraction` (`DRAFT`). Contains **zero** publish or direct Google Sheets nodes. |
| `02-publish-content.json` | W02 | `POST /webhook/instaops-publish-v1` | Inactive | Enforces `LIVE_PUBLISH_ENABLED=true`, validates DB `approved_revision === revision && reviewed_revision === revision`, loads authoritative active DB `instaops_media_assets` (ignoring spoofed request media), supports Single Reels/Images and complete **2–10 Image/Video/Mixed Carousels** with bounded `status_code` polling + lock renewal, persists `published_id` before permalink lookup, and preserves lock on uncertain timeout (`VERIFY_MANUALLY`). Contains **zero** direct Google Sheets nodes. |
| `03-scheduled-runner.json` | W03 | 5-minute Cron (`disabled: true`) | Inactive | Atomically claims due `SCHEDULED` + `LATER` rows via `instaops_claim_due_scheduled_posts` (`FOR UPDATE SKIP LOCKED`) and transfers canonical lock + job to W02. |
| `04-content-management.json` | W04 | `POST /webhook/instaops-content-v1` | Inactive | Allowlisted bridge (`LIST_POSTS`, `LIST_MEDIA`, `SYNC_RECORD` routing by permanent IDs across `Posts`, `MediaAssets`, `ExecutionLogs`, `Accounts`, plus `DELETE_MEDIA` / `DELETE_POST` gated by `LIVE_DELETE_ENABLED` + DB `post_uuid` asset ownership verification). |
| `05-recovery-reconciliation.json` | W05 | `POST /webhook/instaops-recovery-v1` | Inactive | Runs `CHECK_CONNECTIONS` (proving Supabase schema/RLS/RPC via `instaops_verify_health_and_rpc`, empty-safe Sheets probe, Cloudinary, Meta Graph, and `n8nEnv` diagnostics) plus Meta Graph provider-verified `VERIFY_PUBLICATION` & `SAFE_RETRY`. |

## Import Order & n8n 2.0 Notes

1. Execute `supabase/migrations/006_upgrade_reliability.sql` (or `INSTALL_FRESH.sql` on a fresh DB) **before** running W01–W05.
2. Import W01–W05 into `https://137.23.61.127.sslip.io` as separate workflows (never overwrite v1 workflows).
3. Bind Google Sheets OAuth2 credentials and configure environment vars / n8n `$vars` per `CREDENTIALS_SETUP.md` (see `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` guidance for hosted n8n 2.0+).
4. Copy each imported workflow's assigned ID into Next.js `.env.local` (`N8N_EXTRACT_WORKFLOW_ID`, etc.).
5. Keep `03-scheduled-runner.json` trigger disabled until `SCHEDULING_ENABLED=true` and integration tests pass.
6. Activate W04 and W05 first (sync/health), verify Settings -> Production Readiness Matrix shows all checks green, then activate W01 and W02.
