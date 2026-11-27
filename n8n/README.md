# InstaOps v2.0 n8n Automation Package

This directory contains the 5 workflow definitions, database/sheet schema migrations, credential setup instructions, and webhook interface contracts for **InstaOps v2.0**.

## Workflows (`n8n/workflows/`)

| File | Role | Trigger | Default State | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `01-extract-upload.json` | W01 | `POST /webhook/instaops-extract-v1` | Inactive | Resolves Instagram URL via hosted downloader, uploads assets to Cloudinary, writes `DRAFT` + `MediaAssets`. Never auto-publishes. |
| `02-publish-content.json` | W02 | `POST /webhook/instaops-publish-v1` | Inactive | Verifies `approved_revision === revision`, blocks Carousels, calls Meta Graph API `v22.0` container + `status_code` poll + `media_publish`, persists permalink. |
| `03-scheduled-runner.json` | W03 | 5-minute Cron (`disabled: true`) | Inactive | Filters `status = SCHEDULED` + `publish_mode = LATER` + `publish_at <= now` and dispatches to W02. |
| `04-content-management.json` | W04 | `POST /webhook/instaops-content-v1` | Inactive | Allowlisted bridge for `LIST_POSTS`, `LIST_MEDIA`, `CREATE_POST`, `UPDATE_POST`, `SCHEDULE_POST`, `CANCEL_SCHEDULE`, `ARCHIVE_POST`, `DELETE_MEDIA`, `DELETE_POST`. |
| `05-recovery-reconciliation.json` | W05 | `POST /webhook/instaops-recovery-v1` | Inactive | Runs `CHECK_CONNECTIONS` health probes and `VERIFY_PUBLICATION` reconciliation updates. |

## Import Order & Verification

1. Do **not** overwrite legacy workflows from v1 (`instagram-manager`). Import W01–W05 into `https://137.23.61.127.sslip.io` as separate workflows.
2. Bind credentials as documented in `CREDENTIALS_SETUP.md`.
3. Copy each imported workflow's assigned ID into Next.js `.env.local` (`N8N_EXTRACT_WORKFLOW_ID`, etc.).
4. Keep `03-scheduled-runner.json` trigger disabled until `SCHEDULING_ENABLED=true` and tests pass.
5. Activate W04 and W05 first (read/health), then W01 (extraction), then W02 (publish) after validating sandbox/dry-run readiness.
