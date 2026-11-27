# InstaOps v2.0 — Advanced Instagram Content Operations Platform

A complete, safety-hardened Instagram content operations platform powered by **Supabase PostgreSQL (primary source of truth)**, **Google Sheets (synchronized reporting layer via outbox queue)**, **Cloudinary (authoritative media storage)**, **online n8n (`https://137.23.61.127.sslip.io`)**, **Hosted Vercel Downloader (`https://ig-dowloader-nnnn.vercel.app`)**, and **Meta Graph API `v22.0`** supporting **Reels, Single Images, and complete multi-item / mixed Carousels (2–10 images & videos)**.

## Core Architectural Principles

- **Supabase Primary Source of Truth:** Permanent UUID primary keys (`id`) across `instaops_posts`, `instaops_media_assets`, `instaops_post_revisions`, `instaops_jobs`, `instaops_job_locks`, `instaops_idempotency_keys`, `instaops_execution_logs`, `instaops_sync_queue`, and `instaops_audit_events`. Strict RLS revoking all direct `anon`/`authenticated` access; server-only `SUPABASE_SERVICE_ROLE_KEY` never reaches browser bundles.
- **Google Sheets Synchronized Reporting Layer:** Reads/writes never corrupt primary data if Sheets has quota or network outages. All mutations write first to Supabase and enqueue idempotent `instaops_sync_queue` jobs keyed by permanent `post_uuid` / `post_id` (never volatile row numbers).
- **Two-Click Separation:**
  - **Click 1 (`Extract & Upload`)** resolves Instagram URLs via hosted downloader -> uploads every Reel, Image, or mixed Carousel item to Cloudinary -> writes relational `instaops_media_assets` & stops `instaops_posts` in **`DRAFT`**.
  - **Click 2 (`Publish Now` / `Schedule Later`)** checks `approved_revision === revision`, claims Postgres RPC row locks & idempotency keys, executes Meta Graph API `v22.0` container polling (creating child containers + parent `CAROUSEL` container for multi-item posts), persists `published_id` + `permalink`, and syncs Google Sheets.
- **Soft Deletion by Default + Permanent Cloudinary Asset Control:** Archive / soft delete marks `deleted_at` and preserves relational audit logs while optional permanent Cloudinary deletion removes owned objects after explicit ownership & confirmation gates.

## Quick Start (Windows PowerShell)

1. Execute `supabase/INSTALL_FRESH.sql` in your Supabase SQL Editor (`https://cdgwdlhesgcxmswsamrj.supabase.co`).
2. Install packages and run all offline checks:
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
3. Configure `.env.local` from `.env.example` (set your Supabase `anon` and `service_role` keys, rotated n8n credentials, or `DEMO_MODE=true` for offline preview).
4. Start the console:
   ```powershell
   npm run dev
   ```
   Open `http://127.0.0.1:3000`.
