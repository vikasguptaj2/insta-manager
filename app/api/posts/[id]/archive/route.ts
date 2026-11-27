import { handleApiRequest, jsonOk } from '../../../../../lib/api-handler';
import { enforceRateLimit, validateSafeId } from '../../../../../lib/security/http-guard';
import { archivePost } from '../../../../../lib/service';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleApiRequest(
    req,
    async () => {
      enforceRateLimit('posts:archive', 15, 60_000);
      const { id } = await context.params;
      const postId = validateSafeId(id, 'post ID');
      const post = await archivePost(postId);
      return jsonOk({ ok: true, post });
    },
    { requireJson: false },
  );
}
