import { handleApiRequest, jsonOk } from '../../../../lib/api-handler';
import { enforceRateLimit, readJsonBody, validateSafeId } from '../../../../lib/security/http-guard';
import { parseDeleteConfirmInput, parsePatchPostInput } from '../../../../lib/validation/requests';
import { deletePostAndMedia, getPostDetail, updatePostRecord } from '../../../../lib/service';

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleApiRequest(req, async () => {
    const { id } = await context.params;
    const postId = validateSafeId(id, 'post ID');
    const detail = await getPostDetail(postId);
    return jsonOk({ ok: true, ...detail });
  });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleApiRequest(req, async () => {
    enforceRateLimit('posts:patch', 30, 60_000);
    const { id } = await context.params;
    const postId = validateSafeId(id, 'post ID');
    const body = await readJsonBody(req);
    const patch = parsePatchPostInput(body);
    const post = await updatePostRecord(postId, patch);
    return jsonOk({ ok: true, post });
  });
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleApiRequest(req, async () => {
    enforceRateLimit('posts:delete', 6, 60_000);
    const { id } = await context.params;
    const postId = validateSafeId(id, 'post ID');
    const body = await readJsonBody(req);
    const input = parseDeleteConfirmInput(body);
    const result = await deletePostAndMedia(postId, input);
    return jsonOk({ ok: true, ...result });
  });
}
