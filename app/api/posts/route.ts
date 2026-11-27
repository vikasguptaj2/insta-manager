import { handleApiRequest, jsonOk } from '../../../lib/api-handler';
import { readJsonBody, enforceRateLimit } from '../../../lib/security/http-guard';
import { parseCreatePostInput } from '../../../lib/validation/requests';
import { createPostRecord, listPostsData } from '../../../lib/service';

export async function GET(req: Request) {
  return handleApiRequest(req, async () => {
    const url = new URL(req.url);
    const status = (url.searchParams.get('status') ?? 'ALL').toUpperCase();
    const mediaType = (url.searchParams.get('mediaType') ?? 'ALL').toUpperCase();
    const search = (url.searchParams.get('search') ?? '').trim().toLowerCase();
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') ?? 50) || 50));

    const { posts } = await listPostsData();
    const filtered = posts.filter((p) => {
      if (p.status === 'DELETED' && status !== 'DELETED') return false;
      if (status !== 'ALL' && p.status !== status) return false;
      if (mediaType !== 'ALL' && p.media_type !== mediaType) return false;
      if (search) {
        const hay = `${p.post_id} ${p.source_id} ${p.source_username} ${p.caption} ${p.original_caption}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    const totalItems = filtered.length;
    const start = (page - 1) * pageSize;
    return jsonOk({
      ok: true,
      data: filtered.slice(start, start + pageSize),
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / pageSize)),
      },
    });
  });
}

export async function POST(req: Request) {
  return handleApiRequest(req, async () => {
    enforceRateLimit('posts:create', 20, 60_000);
    const body = await readJsonBody(req);
    const input = parseCreatePostInput(body);
    const record = await createPostRecord(input);
    return jsonOk({ ok: true, post: record }, 201);
  });
}
