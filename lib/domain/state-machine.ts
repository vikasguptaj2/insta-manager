import type { ContentRecord, ContentStatus, JobStage } from '../../types/instaops';
import { AppError } from '../errors/codes';
import { text } from './schema';

export const ACTIVE_IN_FLIGHT_STATUSES = new Set<ContentStatus>([
  'EXTRACTING',
  'UPLOADING',
  'PUBLISHING',
  'DELETING',
]);

export const LOCKED_STATUSES = new Set<ContentStatus>([
  'SCHEDULED',
  'EXTRACTING',
  'UPLOADING',
  'PUBLISHING',
  'PUBLISHED',
  'VERIFY_MANUALLY',
  'DELETING',
  'DELETED',
]);

export const JOB_STAGES: readonly JobStage[] = [
  'QUEUED',
  'VALIDATING',
  'FETCHING_SOURCE',
  'DOWNLOADING',
  'UPLOADING_MEDIA',
  'SAVING_RECORDS',
  'CREATING_CONTAINER',
  'PROCESSING_CONTAINER',
  'PUBLISH_REQUESTED',
  'VERIFYING_PUBLICATION',
  'DELETING_ASSETS',
  'RECONCILING',
  'COMPLETED',
  'FAILED',
  'OUTCOME_UNKNOWN',
] as const;

const ALLOWED_TRANSITIONS: Record<ContentStatus, readonly ContentStatus[]> = {
  DRAFT: ['EXTRACTING', 'READY', 'SCHEDULED', 'FAILED', 'ARCHIVED', 'DELETING', 'MEDIA_DELETED', 'DELETED'],
  EXTRACTING: ['UPLOADING', 'DRAFT', 'READY', 'FAILED'],
  UPLOADING: ['READY', 'DRAFT', 'FAILED', 'MEDIA_DELETED'],
  READY: ['SCHEDULED', 'PUBLISHING', 'DRAFT', 'EXTRACTING', 'ARCHIVED', 'DELETING', 'MEDIA_DELETED'],
  SCHEDULED: ['PUBLISHING', 'READY', 'DRAFT', 'ARCHIVED', 'FAILED'],
  PUBLISHING: ['PUBLISHED', 'FAILED', 'VERIFY_MANUALLY'],
  PUBLISHED: ['ARCHIVED', 'MEDIA_DELETED', 'DELETED'], // Explicit delete/archive still checks strict deletion guards
  FAILED: ['EXTRACTING', 'DRAFT', 'READY', 'ARCHIVED', 'DELETING', 'MEDIA_DELETED'],
  VERIFY_MANUALLY: ['PUBLISHED', 'READY', 'DRAFT', 'FAILED', 'ARCHIVED'], // Recovery reconciliation only
  ARCHIVED: ['DRAFT', 'READY', 'DELETING', 'DELETED'],
  DELETING: ['MEDIA_DELETED', 'DELETED', 'FAILED'],
  MEDIA_DELETED: ['EXTRACTING', 'DRAFT', 'ARCHIVED', 'DELETING', 'DELETED'],
  DELETED: [],
};

export function isLockedRecord(record: Pick<ContentRecord, 'status' | 'published_id' | 'published_url'>): boolean {
  if (LOCKED_STATUSES.has(record.status)) return true;
  if (text(record.published_id) || text(record.published_url)) return true;
  return false;
}

export function isInFlightStatus(status: ContentStatus): boolean {
  return ACTIVE_IN_FLIGHT_STATUSES.has(status);
}

export function canTransition(from: ContentStatus, to: ContentStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertValidTransition(from: ContentStatus, to: ContentStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError(
      'POST_LOCKED',
      `Invalid state transition from ${from} to ${to}.`,
      { httpStatus: 409, details: { from, to } },
    );
  }
}

export function isPublishedRecord(record: Pick<ContentRecord, 'status' | 'published_id' | 'published_url'>): boolean {
  return record.status === 'PUBLISHED' || Boolean(text(record.published_id) || text(record.published_url));
}
