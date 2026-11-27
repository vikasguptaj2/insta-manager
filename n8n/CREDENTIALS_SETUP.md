# Online n8n Server Credential & Environment Setup (`https://137.23.61.127.sslip.io`)

Configure these **native n8n Credentials** and **`$vars` Variables** inside online n8n (`https://137.23.61.127.sslip.io`) before activating `01`–`05`.

## 1. Hosted n8n v2.0 `$env` / `$vars` Access & Native HTTP Request Nodes

- All external HTTP requests across `01`–`05` use standard **`n8n-nodes-base.httpRequest` (v4.2)** and **`n8n-nodes-base.wait` (v1.1)** nodes (**zero** `this.helpers.httpRequest` or `fetch()` calls in Code nodes, and zero `$env` references in expressions).
- Hosted n8n 2.0+ sets `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` by default.
  - All InstaOps v2 Code nodes use a safe `readCfg(key, fallback)` helper checking n8n **Variables (`$vars`)** first and `$env` only if permitted, while `W05 CHECK_CONNECTIONS` reports `n8nEnv.envBlocked` cleanly.
  - Store secrets for webhook HMAC/SHA-1 verification (`N8N_WEBHOOK_SECRET`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`) in **n8n Variables (`$vars`)** (or enable `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`). Store bearer/API tokens in the encrypted n8n Credentials below.

## 2. Required n8n Credentials

Create the following credentials in n8n and bind each to the matching nodes across `01`–`05` (replace `CONFIGURE_IN_N8N`):

| Credential Name in Workflows | n8n Credential Type | Configuration Details |
| :--- | :--- | :--- |
| `Google Sheets OAuth2` | `googleSheetsOAuth2Api` | OAuth2 account with read/write access to `GOOGLE_SHEET_ID` (`19kurWKXLoijsf29tKzedhRHbbg7g9qiSZkcjUszHRhs`) |
| `InstaOps Supabase Service Role Auth` | `httpCustomAuth` (Generic Custom Auth) | JSON headers: `{ "headers": { "apikey": "<SUPABASE_SERVICE_ROLE_KEY>", "Authorization": "Bearer <SUPABASE_SERVICE_ROLE_KEY>" } }` |
| `InstaOps Downloader Bearer Auth` | `httpHeaderAuth` (Header Auth) | Header Name: `Authorization`, Value: `Bearer <DOWNLOADER_API_KEY>` |
| `Meta Graph API Token Auth` | `httpHeaderAuth` (Header Auth) | Header Name: `Authorization`, Value: `Bearer <META_GRAPH_TOKEN>` |
| `Cloudinary API Key & Secret (Basic Auth)` | `httpBasicAuth` (Basic Auth) | User: `<CLOUDINARY_API_KEY>`, Password: `<CLOUDINARY_API_SECRET>` |
| `InstaOps Webhook Secret (x-dashboard-secret)` | `httpHeaderAuth` (Header Auth) | Header Name: `x-dashboard-secret`, Value: `<N8N_WEBHOOK_SECRET>` (used by W03 -> W02 dispatch) |

## 3. n8n Variables (`$vars`) / Environment Flags

| Variable | Value / Description |
| :--- | :--- |
| `SUPABASE_URL` | `https://cdgwdlhesgcxmswsamrj.supabase.co` |
| `N8N_WEBHOOK_SECRET` | Newly rotated webhook shared secret matching Next.js `.env.local` |
| `N8N_BASE_URL` | `https://137.23.61.127.sslip.io` |
| `DOWNLOADER_BASE_URL` | `https://ig-dowloader-nnnn.vercel.app` |
| `CLOUDINARY_CLOUD_NAME` | `djkkknb9k` |
| `CLOUDINARY_API_KEY` | Cloudinary API key (needed by W01/W04 Code nodes for upload & `/destroy` SHA-1 signing) |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret (needed by W01/W04 Code nodes for SHA-1 signing) |
| `INSTAGRAM_USER_ID` | `17841453414532595` (`@vikas.sphere`) |
| `INSTAGRAM_GRAPH_VERSION` | `v22.0` |
| `GOOGLE_SHEET_ID` | `19kurWKXLoijsf29tKzedhRHbbg7g9qiSZkcjUszHRhs` |
| `LIVE_PUBLISH_ENABLED` | Keep `'false'` for dry-run safety; set `'true'` only when approved for live Instagram publishing in W02/W03 |
| `LIVE_DELETE_ENABLED` | Keep `'false'` until permanent Cloudinary asset deletion in W04 is explicitly approved |
| `SCHEDULING_ENABLED` | Keep `'false'` until scheduled cron tests pass |
