import { handleApiRequest, jsonOk } from '../../../lib/api-handler';
import { getReadinessDiagnostics } from '../../../lib/service';

export async function GET(req: Request) {
  return handleApiRequest(req, async () => {
    const url = new URL(req.url, 'http://127.0.0.1:3000');
    const forceRefresh =
      url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
    const { readiness, connections, validation, requestId, fromCache, checkedAt } =
      await getReadinessDiagnostics(fetch, { forceRefresh });
    return jsonOk({
      ok: true,
      connections,
      readiness,
      validation,
      requestId,
      fromCache,
      checkedAt,
    });
  });
}
