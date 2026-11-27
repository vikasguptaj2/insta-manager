# Webhook & Execution Contracts (Next.js BFF <-> Online n8n W01–W05)

All webhooks validate header `x-dashboard-secret` via constant-time compare.

## W01 — Extract & Upload (`POST /webhook/instaops-extract-v1`)
- Request: `{ action: "EXTRACT", post_uuid, post_id, source_instagram_url, expected_revision, request_id, job_id, authorized: true }`
- Updates Supabase `instaops_posts` (`DRAFT`) & `instaops_media_assets` (1..N items) + pushes non-fatal reporting row to Google Sheets.

## W02 — Publish Content (`POST /webhook/instaops-publish-v1`)
- Request: `{ action: "PUBLISH", post_uuid, post_id, ig_user_id, media_type, caption, media_url, media_items, reviewed_revision, confirm: true, ... }`
- Re-reads `instaops_posts` & `instaops_media_assets` from Supabase, verifies revision lock, publishes Single Reel/Image OR 2–10 mixed Carousel (`is_carousel_item=true` -> `CAROUSEL`), writes checkpoints & permalink to Supabase + reporting Sheets.

## W03 — Scheduled Runner (`Cron`, disabled by default)
- Queries Supabase `instaops_posts` where `status=SCHEDULED`, `publish_mode=LATER`, `deleted_at IS NULL`, `publish_at <= now`, and invokes W02.

## W04 — Sheets Sync & Cloudinary Governance (`POST /webhook/instaops-content-v1`)
- Actions: `SYNC_RECORD` (idempotent `appendOrUpdate` matched strictly by permanent `post_id` / `post_uuid`), `LIST_POSTS`, `LIST_MEDIA`, `CREATE_POST`, `UPDATE_POST`, `SCHEDULE_POST`, `CANCEL_SCHEDULE`, `ARCHIVE_POST`, `DELETE_MEDIA` (`confirm: true` -> Cloudinary `/destroy`), `DELETE_POST`.

## W05 — Recovery & Health (`POST /webhook/instaops-recovery-v1`)
- `CHECK_CONNECTIONS`: returns `{ ok: true, services: { supabase, sheets, cloudinary, instagram } }`
- `SAFE_RETRY` / `VERIFY_PUBLICATION`: updates `instaops_posts` directly in Supabase.
