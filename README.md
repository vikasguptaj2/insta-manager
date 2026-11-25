# InstaOps — Local Instagram automation manager

A Next.js App Router application for the **existing Instagram v10 workflow**. No other platforms, DM automation, new database, or replacement Docker stack. The Next.js UI and server use your existing 15-column Google Sheet and n8n as the source of truth. This package does not change your original workflow or sheet on extraction.

## 1 — Requirements
- Windows laptop, Node.js 22 LTS recommended (minimum Node 20.9), npm and internet for first npm install.
- Your existing Docker n8n instance reachable at `http://localhost:5678`, existing `ig-downloader:8765` internal Docker service and its current API authorization.
- Existing Google Sheets OAuth2, Cloudinary, Instagram community node and OpenRouter Bearer Auth credentials in the **same n8n instance**. Existing community node packages must already be installed: `n8n-nodes-cloudinary` and `@mookielianhd/n8n-nodes-instagram`.
- Instagram account A, Instagram user ID `17841453414532595`, same Cloudinary cloud and same Google Sheet (document ID `19kurWKXLoijsf29tKzedhRHbbg7g9qiSZkcjUszHRhs`, gid `18819980`). The workflow has these hard-coded exactly as in the original; account and sheet variables in `.env.local` document the existing configuration, not a multi-account switch. Only the label/timezone, API URL, workflow ID, webhook paths and key/secret are used by the app at runtime.

## 2 — Extract to a new folder
Keep it separate from the existing `testing_worflow` Docker project. Example: extract into
`C:\Users\vikas\Documents\n8n-projects\n8n-local-workspace\instagram-manager`.
Do not overwrite any earlier project. Open that new directory in PowerShell or VS Code.

## 3 — Import two workflow files
1. Back up the sheet and export your current workflow. The exact v10 original is included as `n8n/v10-original.json` for reference only. **Do not import or activate it if your current workflow already exists.**
2. Import `n8n/sheets-bridge.json` into n8n as a NEW workflow. It reads the same sheet and validates draft mutations. Re-select the same `Google Sheets account 3` credential if necessary. Save/publish/activate this bridge. It has no schedule and never publishes Instagram content. Its production path is `/webhook/instagram-manager-sheet-v1`.
3. Import `n8n/v10-dashboard.json` into n8n as a NEW workflow. It is v10 with a webhook branch, input validation, execution acknowledgement, and safer defaults (editor manual starts in CHECK; scheduled old-AI-error fallback off). Existing schedule remains every 30 minutes; all publisher/downloader/Cloudinary/AI nodes and credential refs are preserved. Re-select existing credentials if n8n asks. **Keep the imported workflow inactive for now.**
4. Copy the new dashboard workflow's ID from its editor URL, usually `http://localhost:5678/workflow/<id>`.
5. Before ever activating this copy, deactivate v9/v10 and all other workflows that consume the same publishing queue, wait for active runs to finish, inspect current READY/NEW rows, and set rows you do not want published to DRAFT. The old workflows remain saved and untouched in structure; do not run them concurrently. The first scheduled run may publish approved content after activation.

For a read-only first connection, you can temporarily set N8N_WORKFLOW_ID to your original workflow ID (and keep that workflow's current settings). The bridge can show the sheet and API history without changing publishing. Dashboard-trigger and pause/activate controls require the dashboard copy, so switch to its ID before enabling them. The new workflow uses its own ID and therefore has separate execution history; old runs remain in your original workflow.

## 4 — Environment file
`.env.local` is included and ready to edit. The same default shared local webhook secret is embedded in the imported bridge and dashboard validation nodes. **Leave it unchanged** for initial testing, or regenerate both workflow exports by running `python scripts/build-workflows.py` after changing `.env.local` before importing. If paths change, update webhook paths in both imports too. The shared secret is only for localhost; it is not an Instagram, Cloudinary or Google key. Do not expose the n8n webhooks or dashboard to the public internet.

You need to fill in only two unknown values for the normal setup:

```dotenv
N8N_API_KEY=PASTE_YOUR_N8N_API_KEY_HERE
N8N_WORKFLOW_ID=PASTE_NEW_DASHBOARD_WORKFLOW_ID_HERE
```

Create the API key in n8n Settings → n8n API (or API Keys, depending on version). It needs permission to read workflows/executions; optional pause/activate requires workflow activation access. Keep the secret and key server-side. Existing service credentials remain in the n8n credential store; JSON export references their IDs and names, not actual OAuth tokens or API secrets. Next.js doesn't need separate Google OAuth, Cloudinary, Meta, or OpenRouter keys. No extra external service signup.

## 5 — Start Next.js

```powershell
npm install
npm test
npm run dev
```

Open `http://localhost:3000`. If 3000 is occupied, Next.js may select the next available port; use its terminal URL. Or run `powershell -ExecutionPolicy Bypass -File .\START_WINDOWS.ps1`.

Use `npm run check:connection` for a read-only check against actual n8n. The bridge must be active. `npm run build` then `npm start` runs the production build locally. `npm run test:v10` executes the included original v10 offline tests. To explore without connecting accounts, set `DEMO_MODE=true` and restart. Demo starts with an empty queue; creating drafts works in memory, and commands create simulated run records only (no media ingestion, external calls, or permanent storage). Return to `DEMO_MODE=false` for real use.

## 6 — Dashboard feature map
- Overview: actual queue counts, workflow status, last execution start, current run link, last refresh, estimated next trigger (only when schedule history supports it), next approved scheduled post, connection errors, pause/activate workflow. Pausing unpublishes the workflow; both schedule and its production webhook stop. Does not cancel in-flight jobs. Manual editor executions can still run while inactive.
- Content library & queue: live read, search/filter, content detail with Cloudinary video/image preview, original/final caption, source, publication ID/link, error. Create a draft with authorized Instagram source URL or existing same-cloud media URL. Edit drafts, approve to NEW or READY, unapprove to DRAFT. No destructive delete or arbitrary status edit.
- Calendar: monthly view, upcoming approved posts, edit scheduled time using laptop timezone; display times in APP_TIMEZONE. Time is stored as ISO UTC for the existing workflow. Schedule pickup depends on n8n interval and backlog. Change schedule interval in n8n (then save/publish); app reads interval, does not alter the node.
- Automation: AUTO, CHECK, INGEST, PUBLISH, HEALTH, AI_TEST, AI_RETRY. Maximum batch 1–10, target one post or all, original-caption fallback option. Execution ID acknowledgement and last 50 n8n execution records, per-node timings and report outputs. Inspect the active execution; polls every 5 seconds while API reports active. n8n may not expose intermediate node data until saved; there is no fabricated real-time progress.
- AI: existing workflow AI_RETRY requires saved media and original caption, final caption empty. Reset AI caption explicitly before regeneration if necessary. Review generated text then approve. Automatic AUTO does not generate AI captions; this is inherited v10 behavior.
- Error center: old AI errors and media errors, safe media retry after inspecting Cloudinary, uncertain-publication protection. Original v10 checkpoint/retry rules apply. `VERIFY_MANUALLY`, `PROCESSING`, `INGESTING`, `AI_PROCESSING`, and published IDs are protected. Reconcile interrupted/uncertain operations directly in n8n/Sheets after checking external outcome. No automatic Instagram retry.
- Settings: connection help, timezone, auto-refresh (15 seconds), n8n configuration. Current workflow supports only Account A, images and reels, no Stories/carousels or analytics API, no Auto DM.

## 7 — First complete live test (do not skip)
1. Leave publishing workflow inactive. Verify bridge reads existing seven rows and execution API shows history. Run CHECK manually in n8n editor (default for dashboard copy) and HEALTH. Inspect REPORT nodes. Run AI_TEST manually by selecting the existing config mode if desired.
2. Ensure old workflows inactive, no runs in progress, all unwanted READY/NEW rows made DRAFT. Activate dashboard copy (through UI or n8n); schedule and production webhook become available. Dashboard CHECK should return a real execution ID immediately, then inspect eligibility report in Automation. Acknowledgement is not publication success.
3. Create one authorized test DRAFT, use INGEST target, verify the Cloudinary URL saved and media preview works. If using SM-NEW-07, first check old v9 Cloudinary asset to avoid duplicates. Inspect failed run and use Retry media or targeted INGEST only after review.
4. Use AI_TEST; then optional AI_RETRY on prepared DRAFT with an original caption and blank final caption. Review AI result or edit caption. Approve, then targeted PUBLISH (NOW) and confirm the actual Instagram post and exact ID in Sheets. Existing v10 may return no permalink; no fabricated link is displayed.
5. Repeat with one authorized image. Test second consecutive execution and CHECK that published rows are protected. Schedule a single test post for the future and observe a real scheduled execution. Do not enable concurrent v9, v10 or editor manual runs. Test schedule pause and activation with no approved content waiting.

## 8 — Troubleshooting
| Symptom | Check |
|---|---|
| n8n HTTP 401 or 403 | API key and permission in `.env.local`; restart Next.js. For OpenRouter 401, repair existing credential in n8n. |
| n8n HTTP 404 on webhook | Workflow not active/published, wrong path, or URL. Use production `/webhook/`, not `/webhook-test/`. |
| Workflow ID missing | Copy ID from dashboard workflow URL and restart app. |
| Bridge error / connection aborted | Confirm n8n running, same OAuth credential; inspect bridge execution and actual node output. |
| Write not confirmed | Refresh queue before trying again; do not assume no write happened. Google Sheets node output differs by n8n version; inspect `Confirm write`. |
| AI retry skipped | Existing media, original caption and blank final caption required. Use CHECK and read report. |
| Cloudinary failed / no URL | Inspect upload result, video size, network and Cloudinary asset library. v10 uses stable asset IDs and bounded retries; v9 random assets can remain. |
| Publication uncertain | Inspect actual Instagram account. Never clear a published ID to repeat. |
| No eligible rows | CHECK report shows reasons. A successful n8n run can contain row-level failures; inspect batch summary. |
| Next trigger missing | No previous scheduled execution, workflow inactive, schedule format not supported by estimator, or history pruned. Inspect actual schedule node. |
| Wrong time | Set n8n and laptop timezone to Asia/Kolkata if desired; calendar displays APP_TIMEZONE. |
| npm fails | Check internet/proxy, Node version, npm registry. No node_modules bundled. |

## 9 — Architecture / limits
`Browser → Next.js route handlers → n8n public API + authenticated local webhooks → existing Google Sheets, local downloader, Cloudinary, OpenRouter, Instagram.` No new database. Google Sheets preserves current row format; no direct access tokens in browser. The bridge uses fixed existing sheet and account, validates every mutation, and never edits published IDs or timestamps on updates. In-memory command exclusion and n8n active-run checks reduce overlap; **not transactional** across a scheduled run, another browser server, direct sheet changes or manual n8n editor runs. Do not run parallel workflows; optionally configure n8n production concurrency limit 1 as appropriate for your instance (does not protect manual runs). Existing sheet status checkpoint guards still apply. Keep the whole archive private because it includes local downloader authorization and shared webhook secret. This is a localhost testing project, not internet-ready authentication or multi-user access.

## 10 — Validation status
26 new dependency-free tests cover domain rules, actual embedded code compilation, graph integrity, credential preservation, and mocked HTTP calls. Original v10 tests are included separately. JSX source was parsed offline using TypeScript's parser. npm registry DNS was unavailable during construction, so npm install, actual Next.js build/browser smoke test, real n8n import, installed community-node compatibility, OAuth/API credentials and external publication were **not live tested here**. Run the tests and live checklist on your laptop before relying on the automation. No external sheet or account was touched during creation.
