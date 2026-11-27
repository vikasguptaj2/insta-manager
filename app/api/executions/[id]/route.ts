import { handleApiRequest, jsonOk } from '../../../../lib/api-handler';
import { validateSafeId } from '../../../../lib/security/http-guard';
import { getExecutionDetailSafe } from '../../../../lib/service';

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleApiRequest(req, async () => {
    const { id } = await context.params;
    const execId = validateSafeId(id, 'execution ID');
    const detail = await getExecutionDetailSafe(execId);
    return jsonOk({ ok: true, detail });
  });
}
