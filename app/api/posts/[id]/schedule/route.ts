import { handleApiRequest, jsonOk } from '../../../../../lib/api-handler';
import { enforceRateLimit, readJsonBody, validateSafeId } from '../../../../../lib/security/http-guard';
import { parseSchedulePostInput } from '../../../../../lib/validation/requests';
import { schedulePost } from '../../../../../lib/service';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleApiRequest(req, async () => {
    enforceRateLimit('posts:schedule', 12, 60_000);
    const { id } = await context.params;
    const postId = validateSafeId(id, 'post ID');
    const body = await readJsonBody(req);
    const input = parseSchedulePostInput(body);
    const post = await schedulePost(postId, input);
    return jsonOk({ ok: true, post });
  });
}
