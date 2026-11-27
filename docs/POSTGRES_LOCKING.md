# Supabase Database Schema, Locking & Security (`POSTGRES_LOCKING.md`)

All SQL migrations live in `supabase/migrations/` and are consolidated inside `supabase/INSTALL_FRESH.sql`.

## Tables (`public.instaops_*`)

- **`instaops_accounts`** — Configured IG Business accounts (`id` UUID PK, `account_key`, `ig_user_id`).
- **`instaops_posts`** — Authoritative content queue with permanent `id` UUID, `post_id` readable code, media counts, captions, revision counters, Meta container IDs (`container_id`, `child_container_ids`), publication URLs, soft delete `deleted_at`, and `sheets_sync_status`.
- **`instaops_media_assets`** — Relational multi-asset storage (`post_uuid` FK `ON DELETE RESTRICT`) tracking multiple images/videos/mixed carousel slides (`media_index`), Cloudinary `public_id` & `asset_id`, `ig_child_container_id`, and permanent deletion timestamps.
- **`instaops_post_revisions`** — Immutable caption revision audit trail per post UUID.
- **`instaops_jobs`**, **`instaops_job_locks`**, **`instaops_idempotency_keys`** — Transactional job states, row leases, and deduplication claims.
- **`instaops_execution_logs`** — Workflow execution audit checkpoints.
- **`instaops_sync_queue`** — Durable outbox queue claimed with `FOR UPDATE SKIP LOCKED` for resilient Google Sheets sync.
- **`instaops_audit_events`** — Append-only security & mutation audit events.

## Security & RLS Enforcement

- Every table has `ENABLE ROW LEVEL SECURITY` with explicit `REVOKE ALL FROM anon, authenticated` and restrictive deny policies (`USING (false)`).
- Every `SECURITY DEFINER` RPC locks `SET search_path = ''` and revokes `EXECUTE` from `PUBLIC, anon, authenticated`, granting execution exclusively to `service_role`.
