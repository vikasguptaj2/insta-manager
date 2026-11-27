# Architecture Overview — InstaOps v2.0 (Supabase Primary + Sync Layer)

```
Browser UI (Next.js App Router on 127.0.0.1:3000 — Anon/Public Keys Only)
   |  (Host Lock + Same-Origin CSRF + Rate Limits + Typed Boundary Validation)
   v
Next.js BFF API Layer (/api/* — Server-Only Service Role Client)
   |-- Primary Database: Supabase PostgreSQL (`public.instaops_*` + RLS + SECURITY DEFINER RPCs)
   |-- Atomic Coordination: `instaops_acquire_lock`, `instaops_claim_idempotency`, `instaops_claim_sync_batch`
   |-- Outbox Queue Worker (`/api/sync`) -> Pushes idempotent permanent-UUID syncs to W04
   v
Online n8n Server (https://137.23.61.127.sslip.io) — Workflows W01..W05
   |-- W01: Hosted Downloader (`POST /api/n8n/resolve`) -> Cloudinary -> Supabase `DRAFT` + Sheets Report
   |-- W02: Meta Graph API v22.0 (Single Reel/Image OR 2-10 Mixed Carousel Child + Parent Containers) -> Supabase
   |-- W03: Cron Scheduler reading due rows from Supabase `instaops_posts` -> W02
   |-- W04: Google Sheets `appendOrUpdate` by permanent `post_id`/`post_uuid` + Cloudinary `/destroy`
   |-- W05: Unified Health Probes (Supabase, Sheets, Cloudinary, Meta Graph) + Safe Reconciliation
```

## Failure Isolation Guarantee

Google Sheets rate limits or OAuth hiccups cannot roll back, block, or corrupt Supabase state. Primary mutations commit in PostgreSQL first, record immutable audit & revision history, and enqueue `instaops_sync_queue` tasks processed with `FOR UPDATE SKIP LOCKED` and exponential backoff retries.
