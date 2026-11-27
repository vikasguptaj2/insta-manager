import { handleApiRequest, jsonOk } from '../../../../lib/api-handler';
import { enforceRateLimit, readJsonBody, validateSafeId } from '../../../../lib/security/http-guard';
import { parseDeleteConfirmInput } from '../../../../lib/validation/requests';
import { deleteSingleMediaAsset } from '../../../../lib/service';

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleApiRequest(req, async () => {
    enforceRateLimit('media:deleteOne', 10, 60_000);
    const { id } = await context.params;
    const assetId = validateSafeId(id, 'asset ID');
    const body = await readJsonBody(req);
    const input = parseDeleteConfirmInput(body);
    const result = await deleteSingleMediaAsset(assetId, input);
    return jsonOk({ ok: true, ...result });
  });
}
