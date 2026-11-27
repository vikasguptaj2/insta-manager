# Online n8n Server Credential & Environment Setup (`https://137.23.61.127.sslip.io`)

Configure these **native n8n Credentials** and **`$vars` Variables** inside online n8n (`https://137.23.61.127.sslip.io`) before activating `W00`–`W05`.

## 1. Hosted n8n v2.48+ Architecture (Native Auth & No `$env` Secrets)

- All external HTTP requests across `00`–`05` use standard **`n8n-nodes-base.httpRequest` (v4.2)** and **`n8n-nodes-base.wait` (v1.1)** nodes (**zero** `this.helpers.httpRequest` or `fetch()` calls in Code nodes, and zero `$env` references in expressions).
- All Webhook triggers (`W01`, `W02`, `W04`, `W05`) authenticate `x-dashboard-secret` **natively on the Webhook trigger node** via `httpHeaderAuth` (`CONFIGURE_WEBHOOK`), so unauthenticated calls fail before executing any downstream node.
- Cloudinary uploads (`W01`), deletions (`W04`), and usage probes (`W00`, `W05`) authenticate via **n8n HTTP Basic Auth** (`httpBasicAuth`) — do **not** put `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` into Code nodes.
- Safety gates (`live_publish_enabled`, `live_delete_enabled`, `scheduling_enabled`) are queried from Supabase's authoritative `instaops_get_runtime_settings` RPC (`W02`, `W03`, `W04`, `W05`), failing closed (`false`) if unavailable.

## 2. Exact Credential Assignment Table (`00`–`05`)

Create/bind these **6 distinct credentials** in online n8n (`CONFIGURE_*` placeholders must have **no cross-role reuse**):

| Credential Display Name | ID in JSON Export | n8n Type | Bound Nodes | Configuration Details |
| :--- | :--- | :--- | :--- | :--- |
| `Custom Auth account` | `7QtiSqfp0ZkTj6TQ` | `httpCustomAuth` | All Supabase REST & RPC nodes (`W00`–`W05`) | JSON: `{ "headers": { "apikey": "<SUPABASE_SERVICE_ROLE_KEY>", "Authorization": "Bearer <SUPABASE_SERVICE_ROLE_KEY>" } }` |
| `Unnamed credential` | `J5X8exo033nX3vMT` | `httpBasicAuth` | Cloudinary Upload (`W01`), Destroy (`W04`), Usage (`W00`, `W05`) | User: `<CLOUDINARY_API_KEY>`, Password: `<CLOUDINARY_API_SECRET>` |
| `Google Sheets account` | `PZ0clxfFCt2bQvpU` | `googleSheetsOAuth2Api` | Google Sheets Probe/Read/Sync (`W00`, `W04`, `W05`) | OAuth2 account with read/write access to `19kurWKXLoijsf29tKzedhRHbbg7g9qiSZkcjUszHRhs` |
| `InstaOps Webhook Secret (x-dashboard-secret)` | Replace `CONFIGURE_WEBHOOK` | `httpHeaderAuth` | Webhook Triggers (`W01`, `W02`, `W04`, `W05`) + `W03 -> W02` HTTP node | Header Name: `x-dashboard-secret`, Value: `<N8N_WEBHOOK_SECRET>` (must match `.env.local`) |
| `InstaOps Downloader Bearer Auth` | Replace `CONFIGURE_DOWNLOADER` | `httpHeaderAuth` | `W00` & `W01` Downloader Resolve (`https://ig-dowloader-nnnn.vercel.app/api/n8n/resolve`) | Header Name: `Authorization`, Value: `Bearer <DOWNLOADER_API_KEY>` |
| `Meta Graph API Token Auth` | Replace `CONFIGURE_META` | `httpHeaderAuth` | `W00`, `W02`, & `W05` Meta Graph `v22.0` nodes | Header Name: `Authorization`, Value: `Bearer <META_GRAPH_TOKEN>` |

> [!WARNING]
> **Prevent Duplicate-Canvas Corruption When Replacing Existing Workflows in n8n UI**
> Never click **Import from File** directly onto a workflow canvas that still contains old nodes (this appends a second copy of every node, e.g., 160–430 nodes and duplicate triggers/webhooks).
> Instead, for each existing workflow (`piXQdqGkfekyiDqN`, `tFdUdrvmm4zBSpQx`, `ECgWasiSsSkkhV4Z`, `IgVt3iG684ChAPqG`, `kAu6IU5LZ6tRUoJt`):
> 1. **Export/Download backup** first.
> 2. **Deactivate** the workflow, select all nodes (`Ctrl+A`), and **Delete** until the canvas has `0` nodes (or confirm empty canvas).
> 3. **Import from File** the corresponding `n8n/workflows/01..05-*.json` file.
> 4. Bind `CONFIGURE_WEBHOOK`, `CONFIGURE_DOWNLOADER`, and `CONFIGURE_META`, **Save**, verify exact expected node count (one trigger only), then activate in controlled order.

## 3. Optional n8n Variables (`$vars`)

| Variable | Value / Description |
| :--- | :--- |
| `SUPABASE_URL` | `https://cdgwdlhesgcxmswsamrj.supabase.co` |
| `N8N_BASE_URL` | `https://137.23.61.127.sslip.io` |
| `DOWNLOADER_BASE_URL` | `https://ig-dowloader-nnnn.vercel.app` |
| `CLOUDINARY_CLOUD_NAME` | `djkkknb9k` |
| `INSTAGRAM_USER_ID` | `17841453414532595` (`@vikas.sphere`) |
| `INSTAGRAM_GRAPH_VERSION` | `v22.0` |
| `GOOGLE_SHEET_ID` | `19kurWKXLoijsf29tKzedhRHbbg7g9qiSZkcjUszHRhs` |
| `N8N_GRAPH_POLL_INTERVAL_SEC` | `4` (optional Graph polling interval override) |
| `N8N_GRAPH_MAX_POLLS` | `15` (optional Graph polling cap) |
