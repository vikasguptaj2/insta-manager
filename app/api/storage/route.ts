import { handleApiRequest, jsonOk } from '../../../lib/api-handler';
import { getOverviewData } from '../../../lib/service';

export async function GET(req: Request) {
  return handleApiRequest(req, async () => {
    const ov = await getOverviewData();
    return jsonOk({ ok: true, storage: ov.storage });
  });
}
