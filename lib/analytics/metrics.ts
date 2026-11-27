import type { ContentRecord, ExecutionLogRecord, MediaAssetRecord } from '../../types/instaops';
import {
  getMonthGridDays,
  getScheduledAndPublishedTimeline,
  getWeekDates,
  toTimezoneDateKey,
  type CalendarSlot,
} from '../scheduling/calendar';

export {
  getMonthGridDays,
  getScheduledAndPublishedTimeline,
  getWeekDates,
  toTimezoneDateKey,
  type CalendarSlot,
};

export interface OperationalAnalytics {
  extractionSuccessRate: number | null;
  publicationSuccessRate: number | null;
  reelsCount: number;
  imagesCount: number;
  carouselsCount: number;
  dailyActivity: Array<{ label: string; published: number; failed: number }>;
  failedCategories: Array<{ code: string; count: number }>;
  totalTrackedStorageBytes: number;
  averageExecutionDurationMs: number | null;
  sourceEngagementTotals: {
    postsWithMetrics: number;
    totalSourceLikes: number;
    totalSourceComments: number;
    totalSourcePlays: number;
  };
}

/** Compute strict real-data operational analytics with zero fabricated performance numbers. */
export function computeOperationalAnalytics(
  posts: ContentRecord[],
  assets: MediaAssetRecord[],
  logs: ExecutionLogRecord[],
  timeZone = 'Asia/Kolkata',
): OperationalAnalytics {
  const extractLogs = logs.filter((l) => l.operation === 'EXTRACT' && ['COMPLETED', 'FAILED', 'success', 'error'].includes(l.status));
  const extractWins = extractLogs.filter((l) => l.status === 'COMPLETED' || l.status === 'success').length;
  const extractionSuccessRate =
    extractLogs.length > 0 ? Math.round((extractWins / extractLogs.length) * 100) : null;

  const publishedPosts = posts.filter((p) => p.status === 'PUBLISHED');
  const failedPublish = posts.filter(
    (p) =>
      p.status === 'VERIFY_MANUALLY' ||
      (p.status === 'FAILED' && /INSTAGRAM|PUBLISH/i.test(p.error_code || p.error_stage)),
  );
  const pubTotal = publishedPosts.length + failedPublish.length;
  const publicationSuccessRate = pubTotal > 0 ? Math.round((publishedPosts.length / pubTotal) * 100) : null;

  const activePosts = posts.filter((p) => p.status !== 'DELETED');
  const reelsCount = activePosts.filter((p) => p.media_type === 'REEL').length;
  const imagesCount = activePosts.filter((p) => p.media_type === 'IMAGE').length;
  const carouselsCount = activePosts.filter((p) => p.media_type === 'CAROUSEL').length;

  const dayMap = new Map<string, { published: number; failed: number }>();
  for (const p of activePosts) {
    const k = toTimezoneDateKey(p.published_at || p.processed_at || p.updated_at, timeZone);
    if (!k) continue;
    const entry = dayMap.get(k) ?? { published: 0, failed: 0 };
    if (p.status === 'PUBLISHED') entry.published++;
    if (p.status === 'FAILED' || p.status === 'VERIFY_MANUALLY') entry.failed++;
    dayMap.set(k, entry);
  }
  const dailyActivity = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-14)
    .map(([label, counts]) => ({ label, ...counts }));

  const failMap = new Map<string, number>();
  for (const p of activePosts) {
    if (p.status !== 'FAILED' && p.status !== 'VERIFY_MANUALLY') continue;
    const code = p.error_code || (p.status === 'VERIFY_MANUALLY' ? 'PUBLISH_OUTCOME_UNKNOWN' : 'UNCLASSIFIED_ERROR');
    failMap.set(code, (failMap.get(code) ?? 0) + 1);
  }
  const failedCategories = Array.from(failMap.entries())
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);

  const totalTrackedStorageBytes = assets
    .filter((a) => a.storage_status === 'ACTIVE')
    .reduce((sum, a) => sum + (a.file_size_bytes || 0), 0);

  const durations = logs
    .map((l) => l.duration_ms)
    .filter((d): d is number => typeof d === 'number' && Number.isFinite(d) && d >= 0);
  const averageExecutionDurationMs =
    durations.length > 0 ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : null;

  let postsWithMetrics = 0;
  let totalSourceLikes = 0;
  let totalSourceComments = 0;
  let totalSourcePlays = 0;
  for (const p of activePosts) {
    const likes = Number(p.source_like_count);
    const comments = Number(p.source_comment_count);
    const plays = Number(p.source_play_count);
    if (
      (p.source_like_count !== '' && Number.isFinite(likes)) ||
      (p.source_comment_count !== '' && Number.isFinite(comments)) ||
      (p.source_play_count !== '' && Number.isFinite(plays))
    ) {
      postsWithMetrics++;
    }
    if (Number.isFinite(likes) && likes > 0) totalSourceLikes += likes;
    if (Number.isFinite(comments) && comments > 0) totalSourceComments += comments;
    if (Number.isFinite(plays) && plays > 0) totalSourcePlays += plays;
  }

  return {
    extractionSuccessRate,
    publicationSuccessRate,
    reelsCount,
    imagesCount,
    carouselsCount,
    dailyActivity,
    failedCategories,
    totalTrackedStorageBytes,
    averageExecutionDurationMs,
    sourceEngagementTotals: {
      postsWithMetrics,
      totalSourceLikes,
      totalSourceComments,
      totalSourcePlays,
    },
  };
}
