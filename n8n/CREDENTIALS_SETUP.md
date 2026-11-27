# Online n8n Server Credential & Environment Setup (`https://137.23.61.127.sslip.io`)

Configure these credentials, server flags, and variables inside online n8n (`https://137.23.61.127.sslip.io`) before activating `01`–`05`.

## 1. Hosted n8n v2.0 `$env` / `$vars` Access Requirement

Hosted n8n 2.0+ sets `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` by default, which blocks `$env.*` inside Code nodes and expressions.
- All InstaOps v2 Code nodes use a safe `readCfg(key, fallback)` helper checking `$env` first (catching access-denied errors without crashing) and falling back to n8n **Variables (`$vars`)**, while `W05 CHECK_CONNECTIONS` surfaces `n8nEnv.envBlocked`.
- Set `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` on the n8n container environment, **or** populate the keys below as n8n Variables (`$vars`) alongside `Google Sheets OAuth2`.

## 2. n8n Credentials
- **Google Sheets OAuth2 (`googleSheetsOAuth2Api`)** linked to `GOOGLE_SHEET_ID` (`19kurWKXLoijsf29tKzedhRHbbg7g9qiSZkcjUszHRhs`), covering tabs `Posts`, `MediaAssets`, `ExecutionLogs`, and `Accounts`.

## 3. n8n Server Environment Variables / `$vars`

| Variable | Description |
| :--- | :--- |
| `SUPABASE_URL` | `https://cdgwdlhesgcxmswsamrj.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Elevated server-only Supabase key (never store in frontend bundles!) |
| `N8N_WEBHOOK_SECRET` | Newly rotated webhook shared secret matching Next.js `.env.local` |
| `N8N_BASE_URL` | `https://137.23.61.127.sslip.io` |
| `DOWNLOADER_BASE_URL` | `https://instagram-downloader-psi-one.vercel.app` |
| `DOWNLOADER_API_KEY` | Hosted downloader API bearer key |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Cloudinary upload & `/destroy` keys (`djkkknb9k`) |
| `INSTAGRAM_USER_ID` / `INSTAGRAM_GRAPH_VERSION` / `META_GRAPH_TOKEN` | `@vikas.sphere` (`17841453414532595`), `v22.0`, valid long-lived IG Graph token |
| `GOOGLE_SHEET_ID` | `19kurWKXLoijsf29tKzedhRHbbg7g9qiSZkcjUszHRhs` |
| `LIVE_PUBLISH_ENABLED` | Set `'false'` for dry-run safety; `'true'` only when ready for live Instagram publishing in W02/W03 |
| `LIVE_DELETE_ENABLED` | Set `'false'` until permanent Cloudinary asset deletion in W04 is explicitly approved |
| `SCHEDULING_ENABLED` | Set `'false'` until scheduled cron tests pass |
