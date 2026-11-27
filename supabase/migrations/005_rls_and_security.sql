-- 005_rls_and_security.sql
-- Enables Row-Level Security on every InstaOps table in `public` and revokes direct client table access.
-- All browser interactions flow through authenticated/localhost-guarded Next.js BFF API routes using server-side credentials.

ALTER TABLE public.instaops_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instaops_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instaops_media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instaops_post_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instaops_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instaops_job_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instaops_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instaops_execution_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instaops_sync_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instaops_audit_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.instaops_accounts FROM anon, authenticated;
REVOKE ALL ON TABLE public.instaops_posts FROM anon, authenticated;
REVOKE ALL ON TABLE public.instaops_media_assets FROM anon, authenticated;
REVOKE ALL ON TABLE public.instaops_post_revisions FROM anon, authenticated;
REVOKE ALL ON TABLE public.instaops_jobs FROM anon, authenticated;
REVOKE ALL ON TABLE public.instaops_job_locks FROM anon, authenticated;
REVOKE ALL ON TABLE public.instaops_idempotency_keys FROM anon, authenticated;
REVOKE ALL ON TABLE public.instaops_execution_logs FROM anon, authenticated;
REVOKE ALL ON TABLE public.instaops_sync_queue FROM anon, authenticated;
REVOKE ALL ON TABLE public.instaops_audit_events FROM anon, authenticated;

GRANT ALL ON TABLE public.instaops_accounts TO service_role;
GRANT ALL ON TABLE public.instaops_posts TO service_role;
GRANT ALL ON TABLE public.instaops_media_assets TO service_role;
GRANT ALL ON TABLE public.instaops_post_revisions TO service_role;
GRANT ALL ON TABLE public.instaops_jobs TO service_role;
GRANT ALL ON TABLE public.instaops_job_locks TO service_role;
GRANT ALL ON TABLE public.instaops_idempotency_keys TO service_role;
GRANT ALL ON TABLE public.instaops_execution_logs TO service_role;
GRANT ALL ON TABLE public.instaops_sync_queue TO service_role;
GRANT ALL ON TABLE public.instaops_audit_events TO service_role;

-- Explicit restrictive deny policies for anon & authenticated Data API roles + explicit service_role access
DROP POLICY IF EXISTS "deny_client_accounts" ON public.instaops_accounts;
CREATE POLICY "deny_client_accounts" ON public.instaops_accounts AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_accounts" ON public.instaops_accounts;
CREATE POLICY "service_accounts" ON public.instaops_accounts FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_client_posts" ON public.instaops_posts;
CREATE POLICY "deny_client_posts" ON public.instaops_posts AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_posts" ON public.instaops_posts;
CREATE POLICY "service_posts" ON public.instaops_posts FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_client_media_assets" ON public.instaops_media_assets;
CREATE POLICY "deny_client_media_assets" ON public.instaops_media_assets AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_media_assets" ON public.instaops_media_assets;
CREATE POLICY "service_media_assets" ON public.instaops_media_assets FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_client_post_revisions" ON public.instaops_post_revisions;
CREATE POLICY "deny_client_post_revisions" ON public.instaops_post_revisions AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_post_revisions" ON public.instaops_post_revisions;
CREATE POLICY "service_post_revisions" ON public.instaops_post_revisions FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_client_jobs" ON public.instaops_jobs;
CREATE POLICY "deny_client_jobs" ON public.instaops_jobs AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_jobs" ON public.instaops_jobs;
CREATE POLICY "service_jobs" ON public.instaops_jobs FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_client_job_locks" ON public.instaops_job_locks;
CREATE POLICY "deny_client_job_locks" ON public.instaops_job_locks AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_job_locks" ON public.instaops_job_locks;
CREATE POLICY "service_job_locks" ON public.instaops_job_locks FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_client_idempotency_keys" ON public.instaops_idempotency_keys;
CREATE POLICY "deny_client_idempotency_keys" ON public.instaops_idempotency_keys AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_idempotency_keys" ON public.instaops_idempotency_keys;
CREATE POLICY "service_idempotency_keys" ON public.instaops_idempotency_keys FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_client_execution_logs" ON public.instaops_execution_logs;
CREATE POLICY "deny_client_execution_logs" ON public.instaops_execution_logs AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_execution_logs" ON public.instaops_execution_logs;
CREATE POLICY "service_execution_logs" ON public.instaops_execution_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_client_sync_queue" ON public.instaops_sync_queue;
CREATE POLICY "deny_client_sync_queue" ON public.instaops_sync_queue AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_sync_queue" ON public.instaops_sync_queue;
CREATE POLICY "service_sync_queue" ON public.instaops_sync_queue FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_client_audit_events" ON public.instaops_audit_events;
CREATE POLICY "deny_client_audit_events" ON public.instaops_audit_events AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_audit_events" ON public.instaops_audit_events;
CREATE POLICY "service_audit_events" ON public.instaops_audit_events FOR ALL TO service_role USING (true) WITH CHECK (true);
