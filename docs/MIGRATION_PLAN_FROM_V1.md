# Safe Migration Plan from Legacy v1 (`instagram-manager`) to Supabase Primary v2.0

1. **Revoke Exposed Legacy Secrets First:** Never reuse exposed legacy Docker keys. Generate new `N8N_API_KEY` and `N8N_WEBHOOK_SECRET`.
2. **Keep Legacy Projects Untouched:** Do not edit `instagram-manager` or the hosted Vercel downloader.
3. **Execute Consolidated Supabase Schema:**
   - Open your Supabase Dashboard (`https://cdgwdlhesgcxmswsamrj.supabase.co`) -> **SQL Editor**.
   - Paste and execute [`supabase/INSTALL_FRESH.sql`](../supabase/INSTALL_FRESH.sql) cleanly inside a transaction.
   - Verify all 10 `public.instaops_*` tables, indexes, RLS policies, and RPCs exist using `npm run verify:supabase`.
4. **Update Online n8n (`https://137.23.61.127.sslip.io`):**
   - Run `npm run check:workflows` locally.
   - Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to n8n runtime variables (`n8n/CREDENTIALS_SETUP.md`).
   - Import `n8n/workflows/01..05.json` cleanly without overwriting legacy workflows.
5. **Sync Reporting Sheet (`19kurWKXLoijsf29tKzedhRHbbg7g9qiSZkcjUszHRhs`):**
   - Run `npm run migrate:sheets` (dry-run by default) to confirm legacy columns 1–15 stay preserved and new reporting sync columns (`post_uuid`, `sheets_sync_status`, etc.) match.
6. **Verify Before Enabling Live Publishing:**
   - Configure `.env.local` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, server-only `SUPABASE_SERVICE_ROLE_KEY`) with `LIVE_PUBLISH_ENABLED=false` initially.
   - Run `npm run check:config` and `npm run check:connection`, test Click 1 extraction (`DRAFT`) + mixed Carousel preview + Sheets sync outbox before enabling `LIVE_PUBLISH_ENABLED=true`.
