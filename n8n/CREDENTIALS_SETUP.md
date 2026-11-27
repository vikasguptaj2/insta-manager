# Online n8n Server Credential & Environment Setup (`https://137.23.61.127.sslip.io`)

Configure these credentials and variables inside online n8n (`https://137.23.61.127.sslip.io`) before activating `01`–`05`:

## 1. n8n Credentials
- **Google Sheets OAuth2 (`googleSheetsOAuth2Api`)** linked to `GOOGLE_SHEET_ID` (`19kurWKXLoijsf29tKzedhRHbbg7g9qiSZkcjUszHRhs`).

## 2. n8n Server Environment Variables

| Variable | Description |
| :--- | :--- |
| `SUPABASE_URL` | `https://cdgwdlhesgcxmswsamrj.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Elevated server-only Supabase key (never store in frontend!) |
| `N8N_WEBHOOK_SECRET` | Newly rotated webhook shared secret matching Next.js `.env.local` |
| `N8N_BASE_URL` | `https://137.23.61.127.sslip.io` |
| `DOWNLOADER_BASE_URL` | `https://ig-dowloader-nnnn.vercel.app` |
| `DOWNLOADER_API_KEY` | Hosted downloader API bearer key |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Cloudinary upload & `/destroy` keys (`djkkknb9k`) |
| `INSTAGRAM_USER_ID` / `INSTAGRAM_GRAPH_VERSION` / `META_GRAPH_TOKEN` | `@vikas.sphere` (`17841453414532595`), `v22.0`, valid long-lived IG Graph token |
| `GOOGLE_SHEET_ID` | `19kurWKXLoijsf29tKzedhRHbbg7g9qiSZkcjUszHRhs` |
| `SCHEDULING_ENABLED` | `false` until tested |
