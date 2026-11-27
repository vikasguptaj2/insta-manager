import { handleApiRequest, jsonOk } from '../../../../../lib/api-handler';
import { enforceRateLimit, readJsonBody, validateSafeId } from '../../../../../lib/security/http-guard';
import { parseDeleteConfirmInput } from '../../../../../lib/validation/requests';
import { deletePostMedia } from '../../../../../lib/service';

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleApiRequest(req, async () => {
    enforceRateLimit('posts:deleteMedia', 8, 60_000);
    const { id } = await context.params;
    const postId = validateSafeId(id, 'post ID');
    const body = await readJsonBody(req);
    const input = parseDeleteConfirmInput(body);
    const result = await deletePostMedia(postId, input);
    return jsonOk({ ok: true, ...result });
  });
}
