# InstaOps v2.0 — Advanced Instagram Content Operations Platform

A complete, safety-hardened Instagram content operations platform powered by **Supabase PostgreSQL (primary source of truth)**, **Google Sheets (synchronized reporting layer via transactional outbox queue)**, **Cloudinary (authoritative media storage)**, **online n8n (`https://137.23.61.127.sslip.io`)**, **Hosted Vercel Downloader (`https://ig-dowloader-nnnn.vercel.app`)**, and **Meta Graph API `v22.0`** supporting **Reels, Single Images, and complete multi-item / mixed Carousels (2–10 images & videos)**.

## Core Architectural Principles

- **Supabase Primary Source of Truth:** Permanent UUID primary keys (`id`) across `instaops_posts`, `instaops_media_assets`, `instaops_post_revisions`, `instaops_jobs`, `instaops_job_locks`, `instaops_idempotency_keys`, `instaops_execution_logs`, `instaops_sync_queue`, and `instaops_audit_events`. Strict RLS revoking all direct `anon`/`authenticated` access; server-only `SUPABASE_SERVICE_ROLE_KEY` never reaches browser bundles. Direct `DATABASE_URL` is strictly optional.
- **Canonical Locking & Lease Safety:** All mutations (`EXTRACT`, `PUBLISH`, `SCHEDULE`, `DELETE_MEDIA`, `DELETE_POST`) coordinate on canonical lock key `post:<uuid>` via PostgreSQL `SECURITY DEFINER` RPCs (`instaops_acquire_lock`, `instaops_transfer_or_claim_lock`, `instaops_renew_lock`, `instaops_release_lock`). Ambiguous webhook or `media_publish` timeouts preserve locks and transition posts to `VERIFY_MANUALLY` (`PUBLISH_OUTCOME_UNKNOWN`) until reconciled via Meta Graph API verification.
- **Google Sheets Synchronized Reporting Layer (Outbox-Only):** Neither W01 nor W02 writes directly to Google Sheets. Primary mutations commit in PostgreSQL first and enqueue idempotent `instaops_sync_queue` events flushed to W04 (`SYNC_RECORD`), which routes to `Posts`, `MediaAssets`, `ExecutionLogs`, and `Accounts` by permanent IDs while suppressing stale older revisions and recovering abandoned `PROCESSING` jobs.
- **Two-Click Separation:**
  - **Click 1 (`Extract & Upload`)** resolves Instagram URLs via hosted downloader (`ok: true && status: "ready"`, strict HTTPS + expiry checks), uploads every Reel, Image, or mixed Carousel item to Cloudinary with partial-upload checkpoints, runs `instaops_finalize_extraction`, and stops `instaops_posts` in **`DRAFT`**.
  - **Click 2 (`Publish Now` / `Schedule Later`)** atomically approves `approved_revision === revision`, verifies `LIVE_PUBLISH_ENABLED=true` inside both Next.js and W02, runs bounded Graph `v22.0` child/parent container polling (2–10 mixed Carousel items + lock renewal), persists `published_id` before fetching permalink (never retrying `media_publish`), and enqueues outbox sync.
- **Soft Deletion by Default + Partial-Delete Checkpointing:** Failed or partial Cloudinary deletions checkpoint any confirmed deleted assets as `DELETED`, mark failed assets `PARTIAL_DELETE`, and strictly refuse soft-deleting the parent post until every required asset deletion succeeds.

## Database Initialization vs Upgrade (Supabase SQL Editor)

- **Fresh Database Setup:** Execute `supabase/INSTALL_FRESH.sql` in your Supabase SQL Editor (`https://cdgwdlhesgcxmswsamrj.supabase.co`).
- **Existing Initialized Dev Database (Non-Destructive Upgrade):** Execute `supabase/migrations/006_upgrade_reliability.sql` in the Supabase SQL Editor. It safely adds new columns (`child_container_ids`, `ig_child_container_id`, `lock_key`, `lock_owner`, `source_revision`), indexes, hardened RPCs (`instaops_transfer_or_claim_lock`, `instaops_renew_lock`, `instaops_approve_post_revision`, `instaops_claim_due_scheduled_posts`, `instaops_finalize_extraction`, `instaops_finalize_deletion`, `instaops_recover_stale_sync_jobs`, `instaops_verify_health_and_rpc`), and `service_role` execute grants **without dropping or resetting any existing tables or rows**.

## Quick Start (Windows PowerShell)

1. Run `supabase/migrations/006_upgrade_reliability.sql` (or `supabase/INSTALL_FRESH.sql` on an empty DB).
2. Configure `.env.local` from `.env.example` (set your Supabase `anon` and `service_role` keys, rotated n8n credentials, or `DEMO_MODE=true` for offline preview).
3. Run verification & build commands:
   ```powershell
   cd c:\Users\vikas\Downloads\Instagram_Manager_NextJS_Complete\InstaOps-v2-Advanced
   npm install
   npm run typecheck
   npm run lint
   npm test
   npm run test:integration
   npm run check:workflows
   npm run verify:supabase
   npm run build
   ```
4. Start the console:
   ```powershell
   npm run dev
   ```
   Open `http://127.0.0.1:3000`.
