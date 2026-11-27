# Instagram Publishing Flow (Meta Graph API `v22.0` + Mixed Carousels)

InstaOps v2.0 uses explicit HTTP nodes in **W02 (`02-publish-content.json`)** targeting `@vikas.sphere` (`17841453414532595`).

## Single Reel or Single Image Flow

1. Verify `approved_revision === revision`, lock via `instaops_acquire_lock`, and verify Cloudinary URL.
2. `POST /v22.0/{ig_user_id}/media` (`media_type=REELS` + `video_url` OR `image_url`, `caption`).
3. Persist `container_id` to Supabase **`instaops_posts`** immediately.
4. Wait & poll `GET /v22.0/{container_id}?fields=status_code,status` until `FINISHED`.
5. `POST /v22.0/{ig_user_id}/media_publish` (`creation_id`), fetch `permalink`, mark `PUBLISHED` in Supabase, and enqueue Sheets sync.

## Complete Mixed Carousel Flow (`2–10` Images, Videos, or Mixed)

1. Validate `2 <= activeAssets.length <= 10` ordered by `media_index`.
2. **Create Child Containers (`is_carousel_item=true`):**
   - For image items: `POST /v22.0/{ig_user_id}/media` (`is_carousel_item=true`, `image_url`).
   - For video items: `POST /v22.0/{ig_user_id}/media` (`is_carousel_item=true`, `media_type=VIDEO`, `video_url`).
3. Wait for child video/image container readiness (`WAIT | Carousel Children Ready`).
4. **Create Parent Carousel Container:** `POST /v22.0/{ig_user_id}/media` (`media_type=CAROUSEL`, `children=<comma-separated-child-ids>`, `caption`).
5. Save parent `container_id` checkpoint to Supabase, poll parent `status_code` -> `FINISHED` -> `media_publish` -> fetch `permalink` -> update Supabase & sync Sheets.

Indeterminate responses always transition safely to **`VERIFY_MANUALLY`** rather than blindly retrying.
