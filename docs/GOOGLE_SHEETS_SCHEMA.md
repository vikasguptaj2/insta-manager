# Google Sheets Reporting Sync Schema

Google Sheets (`19kurWKXLoijsf29tKzedhRHbbg7g9qiSZkcjUszHRhs`, gid `18819980`) operates as a **synchronized reporting layer** driven asynchronously by Supabase's `instaops_sync_queue` outbox table.

- **Permanent ID Synchronization (Never Row Numbers):** W04 updates rows using `appendOrUpdate` matched against `post_id` and records the permanent `post_uuid` / `asset_uuid` column. Reordering, filtering, or inserting rows in Google Sheets never shifts or breaks updates.
- **Preserved Legacy Columns:** Columns 1–15 (`post_id` through `processed_at`) stay untouched in exact legacy order, followed by extended audit & UUID sync columns (total 52 columns in `Posts`, 24 columns in `MediaAssets`).
- **Soft Delete Reporting:** Deleting a post in Supabase calls `instaops_soft_delete_post()` and enqueues a `SOFT_DELETE` sync record updating `status = DELETED` and `deleted_at` in Sheets cleanly.
- **Formula Safety:** `toSafeSheetRow()` escapes formula prefixes (`=`, `+`, `-`, `@`, `\t`, `\r`) before leaving the server.
