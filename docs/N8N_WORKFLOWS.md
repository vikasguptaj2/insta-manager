# n8n Workflows Reference (`W01`–`W05` + Supabase Backend)

All 5 workflows in `n8n/workflows/` operate against **Supabase REST/RPC APIs** (`$env.SUPABASE_URL`, `$env.SUPABASE_SERVICE_ROLE_KEY`) and **Google Sheets (`Posts`)** without storing hardcoded tokens.

| File | Purpose |
| :--- | :--- |
| `01-extract-upload.json` | Extracts source URLs via `/api/n8n/resolve`, uploads all assets (Reels/Images/Carousels) to Cloudinary, updates `instaops_posts` (`DRAFT`) & `instaops_media_assets` in Supabase, and pushes non-fatal reporting sync to Sheets by `post_id`. |
| `02-publish-content.json` | Reads Supabase post + ordered child assets, verifies `approved_revision === revision`, publishes single Reels/Images OR 2–10 item mixed Carousels via Meta Graph API `v22.0` (`is_carousel_item=true` -> parent `CAROUSEL`), writes checkpoints & `PUBLISHED` state back to Supabase. |
| `03-scheduled-runner.json` | Disabled by default Cron; reads due `SCHEDULED` + `LATER` rows directly from Supabase `instaops_posts` when `$env.SCHEDULING_ENABLED === 'true'` and triggers W02. |
| `04-content-management.json` | Google Sheets synchronization & Cloudinary governance bridge: handles `SYNC_RECORD` (idempotent `appendOrUpdate` by permanent `post_id`/`post_uuid`), legacy CRUD, and SHA-1 signed Cloudinary `/destroy`. |
| `05-recovery-reconciliation.json` | Probes Supabase `instaops_accounts`, Google Sheets, Cloudinary `/usage`, and Meta Graph IG account health (`CHECK_CONNECTIONS`), plus executes `SAFE_RETRY` and `VERIFY_PUBLICATION` updates directly on Supabase. |
