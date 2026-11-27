# Console UI Guide (`InstaOps v2.0`)

1. **Overview (`/dashboard`):** Queue KPIs, next scheduled post in `Asia/Kolkata`, Supabase + 7-service health summary, pending Google Sheets outbox sync count, and recent queue records.
2. **Post Studio (`/create`):** Split review workspace displaying permanent UUID & Google Sheets sync status badge:
   - **Click 1 (`Extract & Upload`)** stores Reel, Image, or 2–10 mixed Carousel slides in Cloudinary & Supabase (`DRAFT`) with interactive video/image slide viewer.
   - **Click 2 (`Publish Now` / `Schedule Later`)** validates revision lock and publishes single Reels, single Images, AND mixed Carousels via explicit confirmation dialog.
3. **Content Queue (`/content`):** Filter by status/media type, inspect permanent IDs, edit captions before publish, unschedule, archive, soft-delete posts, or delete stored media.
4. **Media Library (`/media`):** Search & preview individual Cloudinary assets (`public_id`, `asset_id`, size), copy URLs, and explicitly execute permanent Cloudinary asset removal.
5. **Calendar (`/calendar`):** `Asia/Kolkata` Month/Week/Agenda views storing UTC timestamps.
6. **Published (`/published`):** Verified Instagram `published_id`, permalink, asset status, Archive action.
7. **Analytics (`/analytics`):** Honest execution rates, error category breakdowns, and separate source engagement reference totals.
8. **Executions (`/executions`):** Durable Postgres jobs, active `instaops_job_locks`, n8n execution step inspector, and `ExecutionLogs`.
9. **Recovery (`/recovery`):** Safe Retry, `VERIFY_MANUALLY` reconciliation modal, stale lock checks, and **Google Sheets Outbox Sync Queue** manual Flush button.
10. **Settings (`/settings`):** Server validation summary (zero exposed secrets), service health test matrix, feature flags, and UI theme toggles.
