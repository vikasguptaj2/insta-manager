# Cloudinary Media Governance, Soft Delete & Permanent Asset Removal

- **Cloud Name:** `djkkknb9k`
- **Owned Object Namespace:** `instaops-v2/<post_id>/item_<index>_<shortcode>` tracked relationally in **`public.instaops_media_assets`** with foreign key `post_uuid -> instaops_posts.id`.

## Soft Delete vs Permanent Cloudinary Removal

1. **Soft Delete Post (`instaops_soft_delete_post` — Default):**
   - Marks `instaops_posts.status = 'DELETED'` and `deleted_at = NOW()`.
   - Preserves revision history and audit events cleanly in Supabase.
   - Enqueues `SOFT_DELETE` sync job to Google Sheets keyed by permanent `post_uuid` / `post_id`.
   - Blocks soft deletion on `PUBLISHED` posts (use **Archive** instead).
2. **Permanent Cloudinary Deletion (Explicit Dashboard Action):**
   - **Option A (`DELETE /api/posts/:id/media`):** Destroys all owned Cloudinary assets via `/destroy?invalidate=true`, sets `instaops_media_assets.permanently_deleted_at = NOW()` + `storage_status = 'DELETED'`, updates post (`MEDIA_DELETED`), and syncs Sheets.
   - **Single Asset Destroy (`DELETE /api/media/:id`):** Removes an individual Carousel slide or asset directly from Cloudinary & `Media Library` after ownership validation and confirmation modal.
3. **Protection Guards:** Assets lacking verified `cloudinary_public_id` or marked `UNMANAGED` cannot be deleted cleanly until reconciled.
