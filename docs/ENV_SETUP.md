# Environment Configuration Guide (`ENV_SETUP.md`)

Copy `.env.example` to `.env.local` inside `InstaOps-v2-Advanced/`. Never commit `.env.local` or expose `SUPABASE_SERVICE_ROLE_KEY` in client components.

| Variable | Description | Security Boundary |
| :--- | :--- | :--- |
| `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_URL` | `https://cdgwdlhesgcxmswsamrj.supabase.co` | Public project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_ANON_KEY` | Publishable anon key (RLS blocks direct access to `instaops_*` tables) | Public client-safe |
| `SUPABASE_SERVICE_ROLE_KEY` | Elevated server-only key used exclusively by Next.js BFF & n8n HTTP nodes | **Server-only** (never `NEXT_PUBLIC_`) |
| `DEMO_MODE` | `true` (isolated memory store) / `false` (Supabase + n8n) | Server |
| `ATOMIC_LOCK_PROVIDER` | `supabase` (default), `postgres` (direct `DATABASE_URL`), or `local` | Server |
| `SHEETS_SYNC_ENABLED` | Enables durable outbox synchronization to Google Sheets | Server |
| `N8N_BASE_URL` / `N8N_API_KEY` / `N8N_WEBHOOK_SECRET` | Online n8n instance (`https://137.23.61.127.sslip.io`) with rotated credentials | **Server-only** |
| `DOWNLOADER_BASE_URL` / `DOWNLOADER_API_KEY` | `https://ig-dowloader-nnnn.vercel.app` extractor auth | **Server-only** |
| `LIVE_PUBLISH_ENABLED` / `LIVE_DELETE_ENABLED` / `SCHEDULING_ENABLED` | Safety feature gates defaulting to `false` | Server |
