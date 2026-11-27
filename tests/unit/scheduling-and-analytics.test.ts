import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeOperationalAnalytics } from '../../lib/analytics/metrics';
import { assertValidScheduleIso } from '../../lib/domain/posts';
import {
  normalizeContentRecord,
  normalizeExecutionLogRecord,
  normalizeMediaAssetRecord,
} from '../../lib/domain/schema';
import {
  formatTimestampInTimezone,
  getMonthGridDays,
  getScheduledAndPublishedTimeline,
  getWeekDates,
  localDateTimeInputToUtcIso,
  toTimezoneDateKey,
  utcIsoToLocalDateTimeInput,
} from '../../lib/scheduling/calendar';

describe('Scheduling timezone conversion & operational analytics', () => {
  it('converts Asia/Kolkata local datetime inputs to exact UTC ISO and back', () => {
    const utcIso = localDateTimeInputToUtcIso('2026-12-01T14:30', 'Asia/Kolkata');
    assert.equal(utcIso, '2026-12-01T09:00:00.000Z');
    assert.equal(utcIsoToLocalDateTimeInput(utcIso, 'Asia/Kolkata'), '2026-12-01T14:30');
    assert.equal(toTimezoneDateKey('2026-12-01T20:00:00.000Z', 'Asia/Kolkata'), '2026-12-02');
    assert.match(formatTimestampInTimezone(utcIso, 'Asia/Kolkata'), /2026|14:30/);
  });

  it('rejects past, malformed, or >90-day future schedules', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const tooFar = new Date(Date.now() + 95 * 86_400_000).toISOString();
    const valid = new Date(Date.now() + 2 * 3600_000).toISOString();

    assert.throws(() => assertValidScheduleIso(past));
    assert.throws(() => assertValidScheduleIso(tooFar));
    assert.throws(() => assertValidScheduleIso('not-a-date'));
    assert.doesNotThrow(() => assertValidScheduleIso(valid));
  });

  it('builds month/week calendar grids and groups timeline items without fabricating', () => {
    const ref = new Date(2026, 10, 15);
    const monthDays = getMonthGridDays(ref);
    assert.equal(monthDays.filter((c) => c.day !== null).length, 30);
    assert.equal(getWeekDates(ref).length, 7);

    const timeline = getScheduledAndPublishedTimeline(
      [
        normalizeContentRecord({
          post_id: 'S1',
          status: 'SCHEDULED',
          publish_mode: 'LATER',
          publish_at: '2026-11-15T12:00:00.000Z',
        }),
        normalizeContentRecord({
          post_id: 'P1',
          status: 'PUBLISHED',
          published_at: '2026-11-15T15:00:00.000Z',
        }),
      ],
      'Asia/Kolkata',
    );
    assert.equal(timeline.get('2026-11-15')?.length, 2);
  });

  it('computes honest analytics with null rates when no runs occurred', () => {
    const empty = computeOperationalAnalytics([], [], []);
    assert.equal(empty.extractionSuccessRate, null);
    assert.equal(empty.publicationSuccessRate, null);
    assert.equal(empty.averageExecutionDurationMs, null);

    const full = computeOperationalAnalytics(
      [
        normalizeContentRecord({
          post_id: 'P1',
          media_type: 'REEL',
          status: 'PUBLISHED',
          published_at: '2026-11-20T10:00:00.000Z',
          source_like_count: '250',
          source_comment_count: '14',
          source_play_count: '4800',
        }),
        normalizeContentRecord({
          post_id: 'P2',
          media_type: 'IMAGE',
          status: 'FAILED',
          error_code: 'INSTAGRAM_PUBLISH_FAILED',
          updated_at: '2026-11-20T11:00:00.000Z',
        }),
      ],
      [
        normalizeMediaAssetRecord({
          internal_asset_id: 'ast_1',
          post_id: 'P1',
          file_size_bytes: 2048,
          storage_status: 'ACTIVE',
        }),
      ],
      [
        normalizeExecutionLogRecord({ log_id: 'l1', operation: 'EXTRACT', status: 'COMPLETED', duration_ms: 1400 }),
        normalizeExecutionLogRecord({ log_id: 'l2', operation: 'EXTRACT', status: 'FAILED', duration_ms: 600 }),
      ],
      'Asia/Kolkata',
    );

    assert.equal(full.extractionSuccessRate, 50);
    assert.equal(full.publicationSuccessRate, 50);
    assert.equal(full.averageExecutionDurationMs, 1000);
    assert.equal(full.totalTrackedStorageBytes, 2048);
    assert.equal(full.sourceEngagementTotals.totalSourceLikes, 250);
    assert.equal(full.failedCategories[0]?.code, 'INSTAGRAM_PUBLISH_FAILED');
  });
});
