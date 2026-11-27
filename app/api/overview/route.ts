import { handleApiRequest, jsonOk } from '../../../lib/api-handler';
import { getOverviewData } from '../../../lib/service';

export async function GET(req: Request) {
  return handleApiRequest(req, async () => {
    const data = await getOverviewData();
    return jsonOk({ ok: true, ...data });
  });
}
