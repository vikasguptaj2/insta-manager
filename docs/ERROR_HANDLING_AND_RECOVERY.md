# Error Handling & Recovery Guide

## Canonical Error Envelope (`lib/errors/codes.ts`)

Every API route returns uniform JSON:
```json
{
  "ok": false,
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "Human-readable actionable explanation.",
    "kind": "conflict",
    "retryable": false
  }
}
```
All 26 `ERROR_CODES` span: input validation (`INVALID_SOURCE_URL`, `INVALID_MEDIA_TYPE`, `CAPTION_TOO_LONG`, `UNSAFE_NUMERIC_ID`), authorization/locks (`UNAUTHORIZED_CONTENT`, `POST_LOCKED`, `DUPLICATE_SOURCE`, `REVISION_CONFLICT`, `SCHEDULE_CONFLICT`, `POST_NOT_FOUND`), upstream extraction (`DOWNLOADER_AUTH_FAILED`, `DOWNLOADER_UNAVAILABLE`, `DOWNLOADER_FAILED`, `UPSTREAM_RATE_LIMIT`, `MEDIA_UNAVAILABLE`, `MEDIA_TOO_LARGE`, `CLOUDINARY_UPLOAD_FAILED`, `CLOUDINARY_DELETE_FAILED`), Instagram publishing (`INSTAGRAM_CONTAINER_FAILED`, `INSTAGRAM_PUBLISH_FAILED`, `PUBLISH_OUTCOME_UNKNOWN`, `CONTAINER_TIMEOUT`), and infrastructure (`SHEETS_WRITE_FAILED`, `LOCK_ACQUISITION_FAILED`, `N8N_UNREACHABLE`, `CONFIGURATION_ERROR`).

## Reconciling Uncertain Outcomes (`VERIFY_MANUALLY`)

If Meta Graph API `media_publish` times out or container status polling becomes indeterminate, **never blindly re-run publish** (which risks double-posting). Instead open **Recovery** (`/recovery`):
1. Click **Inspect n8n Executions** and check Instagram (`@vikas.sphere`).
2. Click **Verify / Reconcile** on the `VERIFY_MANUALLY` row and check the confirmation checkbox (`inspected: true`):
   - **Post appeared live on IG?** -> Select `MARK_PUBLISHED` and enter the Instagram `published_id` & permalink.
   - **Container failed cleanly without publishing?** -> Select `MARK_FAILED` or `MARK_READY`.
   - **Stuck lock after crash?** -> Select `RELEASE_LOCK`.
