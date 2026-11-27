import { handleApiRequest, jsonOk } from '../../../lib/api-handler';
import { getConnectionsHealth } from '../../../lib/service';

export async function GET(req: Request) {
  return handleApiRequest(req, async () => {
    const connections = await getConnectionsHealth();
    return jsonOk({ ok: true, connections, checkedAt: new Date().toISOString() });
  });
}
