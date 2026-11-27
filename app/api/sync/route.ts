import { handleApiRequest, jsonOk } from '../../../lib/api-handler';
import { enforceRateLimit } from '../../../lib/security/http-guard';
import { getSyncStatusAndFlush } from '../../../lib/service';

export async function GET(req: Request) {
  return handleApiRequest(req, async () => {
    const data = await getSyncStatusAndFlush('LIST');
    return jsonOk({ ok: true, ...data });
  });
}

export async function POST(req: Request) {
  return handleApiRequest(
    req,
    async () => {
      enforceRateLimit('sync:flush', 10, 60_000);
      const data = await getSyncStatusAndFlush('FLUSH');
      return jsonOk({ ok: true, ...data });
    },
    { requireJson: false },
  );
}
