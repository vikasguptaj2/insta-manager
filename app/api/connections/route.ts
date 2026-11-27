import { handleApiRequest, jsonOk } from '../../../lib/api-handler';
import { getReadinessDiagnostics } from '../../../lib/service';

export async function GET(req: Request) {
  return handleApiRequest(req, async () => {
    const { readiness, connections, validation } = await getReadinessDiagnostics();
    return jsonOk({
      ok: true,
      connections,
      readiness,
      validation,
      checkedAt: new Date().toISOString(),
    });
  });
}
