import { handleApiRequest, jsonOk } from '../../../../../lib/api-handler';
import { enforceRateLimit, validateSafeId } from '../../../../../lib/security/http-guard';
import { cancelPostSchedule } from '../../../../../lib/service';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleApiRequest(
    req,
    async () => {
      enforceRateLimit('posts:cancel', 15, 60_000);
      const { id } = await context.params;
      const postId = validateSafeId(id, 'post ID');
      const post = await cancelPostSchedule(postId);
      return jsonOk({ ok: true, post });
    },
    { requireJson: false },
  );
}
