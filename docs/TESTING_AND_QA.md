# Testing & QA Verification Plan

## Automated Test Suites (Offline, Mocked Transport, Zero Live DB Mutation)

- **Unit & Supabase Migration Tests (`npm test`):**
  - `domain-state-machine.test.ts` — Transitions, locking, 52-col schema (`15` legacy columns preserved), formula sanitization, `UNSAFE_NUMERIC_ID`.
  - `posts-and-validation.test.ts` — Permanent UUID generation, URL canonicalization, `2–10` mixed Carousel eligibility, `<2` item carousel blocking.
  - `security-and-ssrf.test.ts` — Loopback/CSRF guards, rate limits, SSRF IP/domain checks, repository secret & client-exposure scan.
  - `downloader-and-cloudinary.test.ts` — Reel/Image/9-slide Carousel parsing, `empty` vs `unavailable` captions, 429 cooldowns, ownership guards.
  - `scheduling-and-analytics.test.ts` — `Asia/Kolkata` timezone round-trips, zero-fabrication operational metrics.
  - `workflows-and-locks.test.ts` — Validates all 5 JSON exports (`W01`–`W05`) against `assertVerifiedWorkflowExport` + `LocalLockStore`.
  - `supabase-database-and-sync.test.ts` — Verifies ordered migrations `001`–`005` + `INSTALL_FRESH.sql`, RLS & `REVOKE EXECUTE` security, `SupabaseLockStore` RPC locking, and Google Sheets outbox sync failure isolation.
- **Integration / E2E Route Handler Tests (`npm run test:integration`):**
  - `e2e-lifecycle.test.ts`, `e2e-recovery-and-deletion.test.ts`, `e2e-security-and-routes.test.ts` covering Two-Click Separation, **complete 9-item Carousel publishing**, Soft Delete vs Permanent Asset Removal, `VERIFY_MANUALLY` reconciliation, `/api/sync` outbox flushing, and fail-closed production gates.
