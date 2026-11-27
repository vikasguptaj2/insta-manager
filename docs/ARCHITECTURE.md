# Architecture Overview — InstaOps v2.0 (Supabase Primary + Durable Outbox Sync)

```
Browser UI (Next.js App Router on 127.0.0.1:3000 — Anon/Public Keys Only)
   |  (Host Lock + Same-Origin CSRF + Rate Limits + Typed Boundary Validation)
   v
Next.js BFF API Layer (/api/* — Server-Only Service Role Client)
   |-- Primary Database: Supabase PostgreSQL (`public.instaops_*` + `instaops_runtime_settings` + RLS + SECURITY DEFINER RPCs)
   |-- Canonical Locks: `post:<uuid>` via `instaops_acquire_lock`, `instaops_transfer_or_claim_lock`, `instaops_renew_lock` (`expires_at >= NOW()`), `instaops_release_lock`
   |-- Pre-Dispatch Approval & Jobs: `instaops_approve_post_revision` + `QUEUED` job persisted BEFORE webhook dispatch
   |-- Deep Diagnostics: 45s default timeout, coalesced probes + 15s cache (`?refresh=1` bypass), workflow duplicate-canvas/conflict inspection
   |-- Outbox Queue Worker (`/api/sync`) -> `instaops_recover_stale_sync_jobs` + `instaops_claim_sync_batch` -> W04 `SYNC_RECORD`
   v
Online n8n Server (https://137.23.61.127.sslip.io) — Workflows W00..W05 (Native Webhook Header Auth + HTTP Request + Wait Nodes)
   |-- W00: Manual read-only 5-provider credential probe (`INSTAOPS_V2_CREDENTIAL_CHECK`)
   |-- W01: Atomic lock transfer -> Downloader (https://ig-dowloader-nnnn.vercel.app/api/n8n/resolve) -> Cloudinary Basic Auth (`instaops-v2/`) -> `instaops_finalize_extraction` (`DRAFT`)
   |-- W02: `instaops_get_runtime_settings` DB gate -> Supabase DB assets + revision OR-check -> Meta Graph v22.0 (1..10 `WAIT`-polled Child+Parent + single `media_publish` + pre-permalink `published_id` save)
   |-- W03: Cron Scheduler -> DB gate (`scheduling_enabled && live_publish_enabled`) -> `instaops_claim_due_scheduled_posts` -> W02 lock handoff
   |-- W04: Multi-tab Sheets Sync + DB gate + pre-delete canonical lock check/claim + Basic Auth Cloudinary `/destroy` + direct `instaops_finalize_deletion`
   |-- W05: Unified Health Probes (Sheets, `instaops_verify_health_and_rpc`, Cloudinary, Meta Graph, `instaops_get_runtime_settings`) + strict persisted/explicit `published_id` Graph verification (zero feed-similarity fallback)
```

## Failure Isolation & Reconciliation Guarantees

- Google Sheets rate limits or OAuth hiccups cannot roll back, block, or corrupt Supabase state. Primary mutations commit in PostgreSQL first, enqueue `instaops_sync_queue` tasks, suppress stale older-revision `POST` updates, and verify Sheets write confirmations.
- Ambiguous webhook timeouts or uncertain `media_publish` errors preserve canonical `post:<uuid>` locks and set `VERIFY_MANUALLY` (`PUBLISH_OUTCOME_UNKNOWN`). `MARK_PUBLISHED` reconciliation requires live Meta Graph API verification via W05 before transitioning to `PUBLISHED`.
- Partial Cloudinary deletions checkpoint confirmed asset deletions, mark failed assets `PARTIAL_DELETE`, refuse parent soft-delete until all assets succeed, and persist `DELETE_OUTCOME_UNKNOWN` if a post-Cloudinary DB checkpoint fails.
