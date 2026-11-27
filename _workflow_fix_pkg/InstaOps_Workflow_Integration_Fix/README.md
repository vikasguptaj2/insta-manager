# InstaOps v2 — Workflow integration fix

Target: your five latest exported online workflows (n8n 2.48.7), not the older local Docker workflows. This is a workflow-only patch; no dashboard source or SQL migration is changed. No live n8n API or service was called by the author. Do not treat this package as production-certified.

## Start with the separate W00 diagnostic

1. Import `00-manual-credential-check.json` into a NEW workflow in your existing workspace. Do not publish it (it is manual-only).
2. Select your existing Custom Auth, Basic Auth and Google Sheets credentials in the corresponding nodes; confirm their values locally. Select the dedicated downloader and Meta Header Auth credentials described below. The export deliberately contains placeholders for these two headers.
3. Execute the manual workflow and inspect `Summarize Credential Results`. Supabase expects HTTP 200; downloader expects 400 for an authenticated request with no URL; Cloudinary expects HTTP 200; Instagram expects HTTP 200 and the exact account ID; Sheets must successfully read the Posts tab. A 400 alone is not proof of auth; also verify a wrong downloader key produces 401 (use a separate test credential, not a production credential edit). W00 does not test upload/publish/delete permissions or webhook authorization.
4. If the Posts tab is missing, create/prepare it non-destructively using the existing project documentation; never clear historical data.

## Credential assignments (your exports)

The five supplied exports use a consistent Supabase Custom Auth reference, Cloudinary Basic Auth reference and Google Sheets OAuth2 reference. These IDs are retained in the patch. They are references, not secrets or evidence that the credentials work. The original header credential ID was reused for three incompatible purposes. All header assignments in the patch are deliberately marked `CONFIGURE_DOWNLOADER`, `CONFIGURE_META`, or `CONFIGURE_WEBHOOK`; replace them with correct credentials before publishing. Never send the downloader key to Meta, or the Meta token to the downloader.

| Credential | Type | Fields | Assign to |
|---|---|---|---|
| Custom Auth account | Custom Auth | `apikey`: Supabase service-role key; `Authorization`: `Bearer <same key>` | All Supabase HTTP nodes |
| Unnamed credential | Basic Auth | User: Cloudinary API key; password: Cloudinary API secret | W01 upload, W04 usage/destroy, W05 usage, W00 usage |
| Google Sheets account | Google Sheets OAuth2 | Existing authorized Google account | All Sheets nodes |
| InstaOps Downloader Bearer Auth | Header Auth | Name `Authorization`, value `Bearer <DOWNLOADER_API_KEY>` | W01 resolve and W00 downloader |
| Meta Graph API Token Auth | Header Auth | Name `Authorization`, value `Bearer <valid Meta publishing token>` | All W02/W05 Graph HTTP nodes and W00 Instagram |
| InstaOps Webhook Secret (x-dashboard-secret) | Header Auth | Name `x-dashboard-secret`, value from dashboard `N8N_WEBHOOK_SECRET` | Incoming webhook triggers W01/W02/W04/W05 and W03 outbound W02 call |

Create separate Header Auth credentials if you do not already have them. No need to expose $env to Code nodes or store Cloudinary API secret in ordinary n8n Variables. Cloudinary server-side Upload API supports Basic Auth: https://cloudinary.com/documentation/image_upload_api_reference . Actual upload and destroy still require controlled provider tests. Rotate the previously shared keys before attaching real production resources.

## Replace workflows safely

Keep your existing five workflows as backups; export each from n8n before replacement. Unpublish the existing W01 and W02 first and ensure none is executing. Import the five corrected files into separate new workflows in the SAME workspace, or replace the canvas of each inactive original after taking a backup. Do not leave two published workflows with the same webhook path. Use the new workflow IDs if you import into new workflows. W00 is separate and does not need an ID in the dashboard.

| File | Nodes | Purpose |
|---|---:|---|
| 01-extract-upload.json | 39 | Source extraction, Cloudinary upload, transactional finalization |
| 02-publish-content.json | 92 | Single and carousel containers, polling, checkpointed publish |
| 03-scheduled-runner.json | 16 | Disabled schedule |
| 04-content-management.json | 43 | Reporting and gated storage operations |
| 05-recovery-reconciliation.json | 36 | Diagnostics and conservative reconciliation |

Select the proper credentials in every node, then save. Check that each IF node has a real condition in the editor. A header credential placeholder must never be left on an activated workflow. W01/W02/W04/W05 incoming Webhook Authentication MUST remain Header Auth; the Code nodes now rely on the native webhook enforcement. Test an invalid secret before sending a valid request. Do not manually execute a downstream publishing/destructive node or pin authentication-success data.

After all credentials and branches are checked, publish W05 first. Test `CHECK_CONNECTIONS` from the dashboard or using the command below. Publish W04 and W01 next, leaving W03 disabled. W02 may be published as a webhook with its live gate false. Before enabling it, test a single authorized extraction and confirm Supabase DRAFT, complete media assets, original caption, and preview.

## Local dashboard IDs and test commands

In PowerShell:

```powershell
cd 'C:\Users\vikas\Downloads\Instagram_Manager_NextJS_Complete\InstaOps-v2-Advanced'
$apiKey = (Get-Content .env.local | Where-Object { $_ -match '^N8N_API_KEY=' }) -replace '^N8N_API_KEY=', ''
(Invoke-RestMethod -Uri 'https://137.23.61.127.sslip.io/api/v1/workflows?limit=100' -Headers @{ 'X-N8N-API-KEY' = $apiKey }).data | Select-Object id,name,active
```

Copy the five corrected workflow IDs into the corresponding `N8N_*_WORKFLOW_ID` fields. Do not change Supabase config or reset the DB. Restart Next.js and run `npm run check:connection`.

After publishing W05 with native Header Auth, check an invalid secret (must reject without reaching provider nodes), then use the valid one:

```powershell
$secret = (Get-Content .env.local | Where-Object { $_ -match '^N8N_WEBHOOK_SECRET=' }) -replace '^N8N_WEBHOOK_SECRET=', ''
Invoke-RestMethod -Uri 'https://137.23.61.127.sslip.io/webhook/instaops-recovery-v1' -Method Post -Headers @{ 'x-dashboard-secret' = $secret } -ContentType 'application/json' -Body '{"action":"CHECK_CONNECTIONS"}' | ConvertTo-Json -Depth 8
```

Never paste credential values into chat or execution notes. The webhook health report includes a Supabase RPC self-test and reads the reporting Posts tab. It is not a media publishing test.

## Safety gates and remaining work

All five corrected exports are inactive. Publishing, deletion and scheduling are explicitly hard-disabled in the relevant Code nodes so that a stale server env flag cannot turn them on. Dashboard .env.local gates remain false as well. Once W00/W05 and W01 succeed, inspect W02 and perform the pre-publication checks before explicitly changing the `livePubCfg` value in `CODE | Verify Auth & Approval Gate` to `true`, then setting dashboard `LIVE_PUBLISH_ENABLED=true`. Do not enable W03 or W04 deletion yet. W05's flags describe its own defaults; verify the real target workflow gate independently. Do not blindly retry if a publish response or checkpoint is ambiguous.

The newly inserted critical response guards stop execution on failed/empty writes or lock renewal. This is deliberately fail-closed; it may leave a job in a nonterminal state requiring manual reconciliation, including if media_publish succeeded but the DB checkpoint failed. Full crash recovery, atomic finalization lock-owner verification, per-item upload checkpoints, all Sheets synchronization branches, carousel readiness and deletion ownership/lease behavior still require live/integration testing. W05 no longer accepts feed similarity as proof of publication. It requires a persisted published ID for automatic verification, and blocks automatic resets for active/uncertain statuses. Do not consider its remaining reconciliation mutations verified yet.

## Offline verification

From the extracted patch directory run `node verify-offline.mjs`. See TEST_REPORT.txt for actual checks performed. This validates graph references, conditions, JavaScript syntax, expression syntax, credential roles, disabled gates and selected mocked critical HTTP failures; it does not execute n8n itself.

The previous dashboard's `lib/n8n/workflow-safety.ts` and regression tests contain assumptions about Code-node secret checks, `$vars` gates and feed matching (`matches.length !== 1`). The new recovery behavior intentionally never infers an ID from feed matches. If you copy the exports into the GitHub project, update those tests/verifier to enforce native webhook Header Auth and persisted-ID-only recovery rather than the old marker; do not remove the actual security requirement. The dashboard code was not edited here and its original full test suite has not been rerun against this patch. Preserve the original project until online validation completes.
