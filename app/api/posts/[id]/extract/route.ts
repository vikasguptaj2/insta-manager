import { handleApiRequest, jsonOk } from '../../../../../lib/api-handler';
import { enforceRateLimit, readJsonBody, validateSafeId } from '../../../../../lib/security/http-guard';
import { parseExtractPostInput } from '../../../../../lib/validation/requests';
import { triggerExtractPost } from '../../../../../lib/service';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleApiRequest(req, async () => {
    enforceRateLimit('posts:extract', 10, 60_000);
    const { id } = await context.params;
    const postId = validateSafeId(id, 'post ID');
    const body = await readJsonBody(req);
    const input = parseExtractPostInput(body);
    const accepted = await triggerExtractPost(postId, input);
    return jsonOk(accepted, 202);
  });
}
