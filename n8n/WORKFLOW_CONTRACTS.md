# Webhook & Execution Contracts (Next.js BFF <-> Online n8n W00–W05)

All webhook workflows (`W01`, `W02`, `W04`, `W05`) authenticate `x-dashboard-secret` natively on the Webhook trigger via `httpHeaderAuth` (`CONFIGURE_WEBHOOK`), verify non-empty DB writes/lock renewals via downstream `CHECK` nodes, and execute external API calls solely via standard `n8n-nodes-base.httpRequest` (`v4.2`) + `n8n-nodes-base.wait` (`v1.1`) nodes bound to isolated credentials (zero `helpers.httpRequest` or `fetch()` in Code nodes).

## W00 — Manual Credential Check (`Manual Trigger`)
- Executes read-only probes across Supabase REST (`instaops_posts`), Downloader (`/api/n8n/resolve`, expecting HTTP `400` on authenticated empty body), Cloudinary Basic Auth (`/usage`), Meta Graph (`v22.0` account ID/username), and Google Sheets (`Posts`). Never mutates media or publishes.

## W01 — Extract & Upload (`POST /webhook/instaops-extract-v1`)
- Request: `{ action: "EXTRACT", post_uuid, post_id, source_instagram_url, expected_revision, lock_key, lock_owner, request_id, job_id, authorized: true }`
- Behavior: Transfers canonical lock `post:<uuid>` via `instaops_transfer_or_claim_lock`, updates `RUNNING` job stages (tolerating blank `job_id` only when manually omitted), validates `ok === true && status === 'ready'` plus non-expired HTTPS URLs from `https://ig-dowloader-nnnn.vercel.app/api/n8n/resolve`, uploads ordered media (`0..N-1`) to Cloudinary (`instaops-v2/` namespace) via `httpBasicAuth` renewing unexpired locks per item and preserving partial checkpoints on failure, finalizes transactionally via `instaops_finalize_extraction` (`DRAFT` only when all assets succeed), inserts execution log, and enqueues outbox sync.

## W02 — Publish Content (`POST /webhook/instaops-publish-v1`)
- Request: `{ action: "PUBLISH", post_uuid, post_id, ig_user_id, reviewed_revision, approved_revision, lock_key, lock_owner, request_id, job_id, confirm: true }`
- Behavior: Queries authoritative Supabase `instaops_get_runtime_settings` RPC (`live_publish_enabled === true`, failing closed `503` if unreachable or `409` if `false`), claims/transfers canonical lock `post:<uuid>`, ignores request media URLs and loads authoritative active DB `instaops_media_assets` + `instaops_accounts` (`enabled=true`), validates `reviewed_revision === revision && approved_revision === revision`, runs bounded native `WAIT` child + parent container polling for Reels, Images, and 2–10 mixed Carousels with `instaops_renew_lock`, calls `media_publish` once, saves `published_id` + `PUBLISHED` **before** permalink lookup, preserves lock as `VERIFY_MANUALLY` (`PUBLISH_OUTCOME_UNKNOWN`) on uncertain timeout, and releases lock only on confirmed terminal outcomes.

## W03 — Scheduled Runner (`Cron`, disabled by default)
- Behavior: Queries Supabase `instaops_get_runtime_settings` RPC (`scheduling_enabled && live_publish_enabled`), claims due `SCHEDULED + LATER + approved_revision=revision` rows atomically via `instaops_claim_due_scheduled_posts` (`FOR UPDATE SKIP LOCKED`), and dispatches lock + job to W02 via `httpHeaderAuth`.

## W04 — Sheets Sync & Cloudinary Governance (`POST /webhook/instaops-content-v1`)
- Actions:
  - `SYNC_RECORD`: Routes by `entity_type` (`POST` -> `Posts` by `post_uuid`, `MEDIA_ASSET` -> `MediaAssets` by `asset_uuid`, `EXECUTION_LOG` -> `ExecutionLogs` by `log_id`, `ACCOUNT` -> `Accounts` by `ig_user_id`), sanitizes cells, and verifies write confirmation (`synced: true`).
  - `DELETE_MEDIA` / `DELETE_POST`: Queries `instaops_get_runtime_settings` (`live_delete_enabled === true`) + `confirm: true`, verifies post state & unresolved `PUBLISH` jobs, verifies caller `lock_owner` against `instaops_job_locks` OR atomically acquires a lock via `instaops_acquire_lock` on direct webhook calls **before** any Cloudinary call, verifies DB `post_uuid` ownership + exact `resource_type`/`delivery_type`, invokes Cloudinary `/destroy` via `httpBasicAuth`, runs `instaops_finalize_deletion` & releases any W04-acquired direct lock on direct webhook runs, and returns strict per-asset `outcomes` (`ok: true, partial_failure`).

## W05 — Recovery & Health (`POST /webhook/instaops-recovery-v1`)
- `CHECK_CONNECTIONS`: Runs empty-safe `Posts` worksheet probe (`alwaysOutputData: true`), `instaops_verify_health_and_rpc` (schema, RLS, anon revocation, atomic lock & expired-lease rejection self-test), Cloudinary `/usage`, Meta Graph `v22.0` account probe, and `instaops_get_runtime_settings` gate telemetry, returning `request_id`, `execution_id`, `checked_at`, and per-provider HTTP status.
- `VERIFY_PUBLICATION` / `SAFE_RETRY`: Strictly verifies destination IG account identity (`owner.id` / account username), compatible `media_type`, duplicate protection, and a **persisted `published_id` or operator-supplied `MARK_PUBLISHED` `published_id`** (**zero caption/feed-similarity guessing**). Retains `VERIFY_MANUALLY` (`verified: false`) whenever no verified ID exists and clears locks only on verified terminal reconciliation.
