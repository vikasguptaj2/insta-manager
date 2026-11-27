import { handleApiRequest, jsonOk } from '../../../../../lib/api-handler';
import { enforceRateLimit, readJsonBody, validateSafeId } from '../../../../../lib/security/http-guard';
import { parseRetryOrReconcileInput } from '../../../../../lib/validation/requests';
import { retryOrReconcilePost } from '../../../../../lib/service';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleApiRequest(req, async () => {
    enforceRateLimit('posts:retry', 10, 60_000);
    const { id } = await context.params;
    const postId = validateSafeId(id, 'post ID');
    const body = await readJsonBody(req);
    const input = parseRetryOrReconcileInput(body);
    const res = await retryOrReconcilePost('RETRY', postId, input);
    return jsonOk(res);
  });
}
