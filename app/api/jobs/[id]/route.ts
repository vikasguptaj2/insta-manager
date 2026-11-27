import { handleApiRequest, jsonOk } from '../../../../lib/api-handler';
import { AppError } from '../../../../lib/errors/codes';
import { validateSafeId } from '../../../../lib/security/http-guard';
import { getLockStore } from '../../../../lib/jobs/lock-store';
import { getExecutionDetailSafe } from '../../../../lib/service';

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return handleApiRequest(req, async () => {
    const { id } = await context.params;
    const jobId = validateSafeId(id, 'job ID');
    const store = getLockStore();
    const job = await store.getJob(jobId);
    if (!job) {
      throw new AppError('POST_NOT_FOUND', `Job ${jobId} not found.`, { httpStatus: 404 });
    }
    const execution =
      job.execution_id ? await getExecutionDetailSafe(job.execution_id).catch(() => null) : null;
    const refreshed = await store.getJob(jobId);
    return jsonOk({ ok: true, job: refreshed ?? job, execution });
  });
}
