# Hosted Instagram Downloader Integration

- **Base URL:** `https://ig-dowloader-nnnn.vercel.app`
- **Auth:** `Authorization: Bearer <DOWNLOADER_API_KEY>` (never sent from browser)

## Endpoints Used

1. **Health Probe (`GET /api/health`):** Called by Next.js `/api/connections` and `scripts/verify-credentials.mjs` to monitor upstream extractor availability and latency.
2. **Media & Metadata Resolution (`POST /api/n8n/resolve`):** Called asynchronously by **W01 (`01-extract-upload.json`)** during Click 1 extraction.

## Caption Status & Parsing Semantics (`lib/downloader/parser.ts`)

- `available`: Non-empty caption returned by structured or fallback parser.
- `empty`: Response explicitly sets `captionStatus: 'empty'` (distinguishes "source had no caption" from extraction error).
- `unavailable`: Response omits caption text or marks extraction partial without returning caption text.
- **Carousel Support (up to 9+ items):** All returned items (`type: 'image' | 'video'`) are validated against strict SSRF/HTTPS allowlists (`.cdninstagram.com`, `.fbcdn.net`, `res.cloudinary.com`), uploaded individually to Cloudinary folder `instaops-v2/<post_id>/`, and recorded in `MediaAssets` with indexed order (`media_index`).
- **Rate Limits (`429`):** Classified cleanly as `UPSTREAM_RATE_LIMIT`, activating UI and retry cooldown banners instead of triggering blind repeat hits.
