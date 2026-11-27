# InstaOps v2.0 n8n Automation Package

This directory contains the 6 hardened workflow definitions (`00`–`05`), Google Sheets schema definition, credential setup, and webhook execution contracts for **InstaOps v2.0**.

## Workflows (`n8n/workflows/`)

| File | Role | Trigger | Default State | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `00-manual-credential-check.json` | W00 | Manual Trigger (`INSTAOPS_V2_CREDENTIAL_CHECK`) | Inactive | Read-only 5-provider manual credential diagnostic (Supabase, Downloader HTTP 400 check, Cloudinary Basic Auth `/usage`, Meta Graph `v22.0` account check, Google Sheets `Posts` tab read). |
| `01-extract-upload.json` | W01 | `POST /webhook/instaops-extract-v1` (Header Auth) | Inactive | Transfers canonical `post:<uuid>` lock, validates `ok=true && status='ready'` + non-expired HTTPS downloader output (`https://ig-dowloader-nnnn.vercel.app`), uploads to Cloudinary via `httpBasicAuth` with per-item lock renewals & partial checkpoints, verifies `CHECK` guards, and finalizes via `instaops_finalize_extraction` (`DRAFT`). |
| `02-publish-content.json` | W02 | `POST /webhook/instaops-publish-v1` (Header Auth) | Inactive | Queries Supabase `instaops_get_runtime_settings` (`live_publish_enabled`, fail-closed), validates DB `approved_revision === revision && reviewed_revision === revision`, loads authoritative active DB `instaops_media_assets`, supports Single Reels/Images and **2–10 Image/Video/Mixed Carousels** using native `WAIT` polling + `instaops_renew_lock`, persists `published_id` before permalink lookup, and preserves lock as `VERIFY_MANUALLY` on uncertain timeout. |
| `03-scheduled-runner.json` | W03 | 5-minute Cron (`disabled: true`) | Inactive | Queries `instaops_get_runtime_settings` (`scheduling_enabled && live_publish_enabled`), atomically claims due rows via `instaops_claim_due_scheduled_posts` (`FOR UPDATE SKIP LOCKED`), and dispatches to W02 via `httpHeaderAuth`. |
| `04-content-management.json` | W04 | `POST /webhook/instaops-content-v1` (Header Auth) | Inactive | Allowlisted bridge (`LIST_POSTS`, `LIST_MEDIA`, `SYNC_RECORD` across `Posts`, `MediaAssets`, `ExecutionLogs`, `Accounts`, plus `DELETE_MEDIA` / `DELETE_POST` gated by DB `live_delete_enabled`, authoritative `instaops_job_locks` / `instaops_jobs` conflict verification, direct lock claim + `instaops_finalize_deletion` + release, and Basic Auth Cloudinary `/destroy`). |
| `05-recovery-reconciliation.json` | W05 | `POST /webhook/instaops-recovery-v1` (Header Auth) | Inactive | Runs `CHECK_CONNECTIONS` (`instaops_verify_health_and_rpc`, empty-safe Sheets probe, Cloudinary `/usage`, Meta Graph, `instaops_get_runtime_settings`), plus strict `VERIFY_PUBLICATION` requiring persisted or operator-explicit `published_id` verified against Meta Graph (**zero feed-similarity/caption fallback**) & `SAFE_RETRY`. |

## Upgrade & Clean Live Rollout Order

1. **Supabase Non-Destructive SQL Upgrade:** Execute `supabase/migrations/007_upgrade_locks_and_settings.sql` in the Supabase SQL Editor (or `INSTALL_FRESH.sql` on a blank DB) **before** running W01–W05.
2. **Clean n8n Import/Replace:** Follow `CREDENTIALS_SETUP.md` strictly (export backup -> deactivate -> clear canvas to 0 nodes -> import `00..05-*.json` -> assign the 3 `CONFIGURE_*` Header Auth credentials -> Save). Verify no duplicate active webhook paths exist.
3. **Verify Config & Credentials Offline + Manual W00:** Run `npm run check:config` and `npm run check:workflows`, then execute `W00` manually in n8n UI.
4. **Activate Recovery & Content Sync First (`W05` & `W04`):** Activate `W05` and `W04`, then verify invalid-secret rejection (`401`/`403`) and valid `npm run check:connection` pass cleanly.
5. **Test Single Extraction First (`W01`):** Activate `W01` only when ready, keep `LIVE_PUBLISH_ENABLED=false` / `LIVE_DELETE_ENABLED=false` / `SCHEDULING_ENABLED=false`, and verify one Reel extracts into `DRAFT` with active Cloudinary assets.
6. **Controlled Manual Publish (`W02`):** Only after `W01`, `W04`, `W05` pass cleanly, activate `W02`, enable `LIVE_PUBLISH_ENABLED=true` in `.env.local` and `instaops_runtime_settings`, and execute one approved single Reel manually (keeping `W03` cron disabled and `live_delete_enabled=false`).
