# Security Hardening Checklist (Supabase Primary + Next.js BFF)

1. **Server-Only Credentials Isolation:**
   - `SUPABASE_SERVICE_ROLE_KEY` lives exclusively in server-only runtime configuration (`lib/config/env.ts` & `lib/supabase/server.ts`), never `NEXT_PUBLIC_`.
   - `lib/supabase/server.ts` enforces `typeof window !== 'undefined'` runtime failure and automated tests verify zero client components under `components/`, `hooks/`, or app pages import server modules.
2. **Row-Level Security & Restricted Functions (`005_rls_and_security.sql`):**
   - `ENABLE ROW LEVEL SECURITY` enabled on all 10 `instaops_*` tables.
   - Explicit `REVOKE ALL ON TABLE ... FROM anon, authenticated` + restrictive deny policies (`USING (false)`).
   - Every `SECURITY DEFINER` Postgres RPC locks `SET search_path = ''` and revokes execution from `PUBLIC, anon, authenticated`.
3. **Request, Origin & SSRF Hardening (`http-guard.ts`, `ssrf.ts`):**
   - Loopback Host lock + Same-Origin `Origin` validation + `cross-site` Sec-Fetch blocking.
   - Private/link-local IP & DNS rebinding protection on external extractor URLs.
   - Formula injection sanitization (`sanitizeSpreadsheetText`) on all reporting sync cells.
4. **Automated Secret Scanning (`lib/security/secret-scan.ts`):**
   - Detects leaked Bearer tokens, Meta tokens (`EAA...`), embedded Postgres URLs, hardcoded Supabase JWTs, and accidental client service-role exposure across codebase files.
