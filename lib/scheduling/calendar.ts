import type { ContentRecord } from '../../types/instaops';

export interface CalendarSlot {
  dateKey: string;
  items: ContentRecord[];
}

/**
 * Formats an ISO timestamp into YYYY-MM-DD in the configured operational timezone.
 */
export function toTimezoneDateKey(isoTimestamp: string, timeZone = 'Asia/Kolkata'): string {
  const ms = Date.parse(isoTimestamp);
  if (!Number.isFinite(ms)) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone,
    }).format(new Date(ms));
  } catch {
    return '';
  }
}

/**
 * Formats an ISO UTC timestamp for human display in the configured operational timezone.
 */
export function formatTimestampInTimezone(
  isoTimestamp: string,
  timeZone = 'Asia/Kolkata',
  includeTime = true,
): string {
  if (!isoTimestamp) return '—';
  const ms = Date.parse(isoTimestamp);
  if (!Number.isFinite(ms)) return isoTimestamp;
  try {
    const opts: Intl.DateTimeFormatOptions = includeTime
      ? {
          year: 'numeric',
          month: 'short',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone,
        }
      : {
          year: 'numeric',
          month: 'short',
          day: '2-digit',
          timeZone,
        };
    return new Intl.DateTimeFormat('en-GB', opts).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * Converts a YYYY-MM-DDTHH:mm value entered in `timeZone` into a canonical UTC ISO string.
 * Supports arbitrary IANA zones cleanly via offset probing without relying on browser local TZ.
 */
export function localDateTimeInputToUtcIso(localValue: string, timeZone = 'Asia/Kolkata'): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localValue.trim());
  if (!match) {
    const fallback = Date.parse(localValue);
    if (!Number.isFinite(fallback)) return '';
    return new Date(fallback).toISOString();
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);

  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(utcGuess));

    const val = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
    const projectedUtc = Date.UTC(val('year'), val('month') - 1, val('day'), val('hour'), val('minute'), 0, 0);
    const offsetMs = projectedUtc - utcGuess;
    return new Date(utcGuess - offsetMs).toISOString();
  } catch {
    return new Date(utcGuess).toISOString();
  }
}

/**
 * Formats a UTC ISO timestamp as YYYY-MM-DDTHH:mm in the target operational timezone
 * for pre-filling `<input type="datetime-local">` controls.
 */
export function utcIsoToLocalDateTimeInput(isoTimestamp: string, timeZone = 'Asia/Kolkata'): string {
  const ms = Date.parse(isoTimestamp);
  if (!Number.isFinite(ms)) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 16);
  }
}

export function getScheduledAndPublishedTimeline(
  posts: ContentRecord[],
  timeZone = 'Asia/Kolkata',
): Map<string, ContentRecord[]> {
  const grouped = new Map<string, ContentRecord[]>();
  for (const post of posts) {
    if (post.status === 'DELETED') continue;
    const rawDate =
      post.status === 'PUBLISHED'
        ? post.published_at || post.processed_at
        : post.publish_mode === 'LATER'
          ? post.publish_at
          : '';
    const key = toTimezoneDateKey(rawDate, timeZone);
    if (!key) continue;
    const list = grouped.get(key) ?? [];
    list.push(post);
    grouped.set(key, list);
  }
  return grouped;
}

export function getMonthGridDays(referenceDate: Date): Array<{ day: number | null; key: string }> {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<{ day: number | null; key: string }> = [];

  for (let i = 0; i < firstDay; i++) {
    cells.push({ day: null, key: `blank-${i}` });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ day: d, key });
  }
  return cells;
}

export function getWeekDates(referenceDate: Date): Array<{ date: Date; key: string }> {
  const start = new Date(referenceDate);
  start.setDate(start.getDate() - start.getDay());
  const out: Array<{ date: Date; key: string }> = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ date: d, key });
  }
  return out;
}

export function getDefaultScheduleInput(timeZone = 'Asia/Kolkata', offsetMs = 3600_000): string {
  return utcIsoToLocalDateTimeInput(new Date(Date.now() + offsetMs).toISOString(), timeZone);
}
