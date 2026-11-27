import { handleApiRequest, jsonOk } from '../../../../../lib/api-handler';
import { enforceRateLimit, readJsonBody, validateSafeId } from '../../../../../lib/security/http-guard';
import { parsePublishPostInput } from '../../../../../lib/validation/requests';
import { triggerPublishPost } from '../../../../../lib/service';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleApiRequest(req, async () => {
    enforceRateLimit('posts:publish', 6, 60_000);
    const { id } = await context.params;
    const postId = validateSafeId(id, 'post ID');
    const body = await readJsonBody(req);
    const input = parsePublishPostInput(body);
    const accepted = await triggerPublishPost(postId, input);
    return jsonOk(accepted, 202);
  });
}
