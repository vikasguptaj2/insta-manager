# Webhook & Execution Contracts (Next.js BFF <-> Online n8n W01–W05)

All webhooks validate header `x-dashboard-secret` via constant-time `safeEqual` and read configuration via `readCfg` (`$vars` first, optional `$env` fallback). All external API requests execute via standard `n8n-nodes-base.httpRequest` (`v4.2`) + `n8n-nodes-base.wait` (`v1.1`) nodes bound to encrypted n8n Credentials (zero `helpers.httpRequest` or `fetch()` in Code nodes).

## W01 — Extract & Upload (`POST /webhook/instaops-extract-v1`)
- Request: `{ action: "EXTRACT", post_uuid, post_id, source_instagram_url, expected_revision, lock_key, lock_owner, request_id, job_id, authorized: true }`
- Behavior: Transfers canonical lock `post:<uuid>` via `instaops_transfer_or_claim_lock`, marks `RUNNING` job stage, validates `ok === true && status === 'ready'` plus non-expired HTTPS URLs from `https://ig-dowloader-nnnn.vercel.app/api/n8n/resolve`, uploads ordered media (`0..N-1`) to Cloudinary (`instaops-v2/` namespace) renewing lock per item and preserving partial checkpoints on failure, finalizes transactionally via `instaops_finalize_extraction` (`DRAFT` only when all assets succeed), inserts execution log, and enqueues outbox sync (zero direct Sheets writes).

## W02 — Publish Content (`POST /webhook/instaops-publish-v1`)
- Request: `{ action: "PUBLISH", post_uuid, post_id, ig_user_id, reviewed_revision, approved_revision, lock_key, lock_owner, request_id, job_id, confirm: true }`
- Behavior: Enforces `LIVE_PUBLISH_ENABLED === 'true'` inside W02, claims/transfers canonical lock `post:<uuid>`, ignores request media URLs and loads authoritative active DB `instaops_media_assets` + `instaops_accounts` (`enabled=true`), validates `reviewed_revision === revision && approved_revision === revision`, runs bounded native `WAIT` child + parent container polling for Reels, Images, and 2–10 mixed Carousels with `instaops_renew_lock`, calls `media_publish` once, saves `published_id` + `PUBLISHED` **before** permalink lookup, preserves lock as `VERIFY_MANUALLY` (`PUBLISH_OUTCOME_UNKNOWN`) on uncertain timeout, and releases lock only on confirmed terminal outcomes.

## W03 — Scheduled Runner (`Cron`, disabled by default)
- Behavior: Enforces `SCHEDULING_ENABLED === 'true' && LIVE_PUBLISH_ENABLED === 'true'`, claims due `SCHEDULED + LATER + approved_revision=revision` rows atomically via `instaops_claim_due_scheduled_posts` (`FOR UPDATE SKIP LOCKED`), and dispatches lock + job to W02 via `httpHeaderAuth`.

## W04 — Sheets Sync & Cloudinary Governance (`POST /webhook/instaops-content-v1`)
- Actions:
  - `SYNC_RECORD`: Routes by `entity_type` (`POST` -> `Posts` by `post_uuid`, `MEDIA_ASSET` -> `MediaAssets` by `asset_uuid`, `EXECUTION_LOG` -> `ExecutionLogs` by `log_id`, `ACCOUNT` -> `Accounts` by `ig_user_id`), sanitizes cells, and verifies write confirmation (`synced: true`).
  - `DELETE_MEDIA` / `DELETE_POST`: Enforces `LIVE_DELETE_ENABLED === 'true'` + `confirm: true`, verifies post state & unresolved `PUBLISH` jobs, verifies caller `lock_owner` against `instaops_job_locks` OR atomically acquires a temporary lock via `instaops_acquire_lock` on direct webhook calls **before** any Cloudinary call, verifies DB `post_uuid` ownership + exact `resource_type`/`delivery_type`, invokes signed Cloudinary `/destroy`, releases any W04-acquired direct lock afterwards, and returns strict per-asset `outcomes` (`ok: true, partial_failure`) for Next.js checkpointing via `instaops_finalize_deletion`.
  - `LIST_POSTS`, `LIST_MEDIA` (returns Cloudinary `/usage` via `httpBasicAuth` when `includeStorage: true`), legacy mutation fallbacks.

## W05 — Recovery & Health (`POST /webhook/instaops-recovery-v1`)
- `CHECK_CONNECTIONS`: Runs `instaops_verify_health_and_rpc` (proving schema, RLS, anon revocation, and atomic lock RPC self-test), empty-safe `Posts` worksheet probe (`alwaysOutputData: true`), Cloudinary `/usage`, Meta Graph `v22.0` account probe, and `n8nEnv` `$vars/$env` diagnostics.
- `VERIFY_PUBLICATION` / `SAFE_RETRY`: Strictly verifies destination IG account identity (`owner.id` / account ID), `PUBLISHED` container state, non-empty caption, compatible `media_type`, duplicate protection, and an exact 1-of-1 unambiguous feed match (**zero `list[0]` or empty-caption fallback**). Retains `VERIFY_MANUALLY` (`verified: false`) whenever ambiguous and clears locks only on verified terminal reconciliation.
