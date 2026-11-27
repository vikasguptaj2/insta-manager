# Operator Runbook — Daily Operations & Incident Response

## Routine Content Workflow

1. Paste owned/authorized Instagram URL in **Post Studio** (`/create`), confirm permission checkbox, click **Create & Extract Media** (**Click 1**).
2. Wait for job badge to complete (`DRAFT`). Inspect video/image/carousel slides in preview.
3. Review extracted vs final editable caption, adjust hashtags/mentions, click **Save Review Draft**.
4. Either click **Publish Now** (**Click 2** + confirmation dialog) for Reels/Images OR set `Asia/Kolkata` date/time and click **Schedule Later**.

## Handling Common Situations

- **Upstream Cooldown Banner (`UPSTREAM_RATE_LIMIT`):** Stop clicking Extract; previously extracted `READY`/`DRAFT` items can still edit and publish normally. Wait until the banner's `until` timestamp expires.
- **Row Stuck in `VERIFY_MANUALLY`:** Never manually re-run W02 directly in n8n without checking `@vikas.sphere` first. Open `/recovery` -> inspect execution trace & IG profile -> apply **Verify / Reconcile**.
- **Clean Up Unused Media:** Go to `/media` -> use **Delete** (single asset) or **Cleanup Unused Assets** (only targets `FAILED`/`ARCHIVED`/`DELETED`/`MEDIA_DELETED` owners). Published posts retain media unless manually managed.
- **Config / Secret Audit:** Run `node scripts/backup-config.mjs` before changing `.env.local` flags, then verify with `npm run check:config`.
