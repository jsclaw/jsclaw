import { test } from 'node:test';
import assert from 'node:assert';
import { parseCron, isValidCron, nextCron } from '../src/cron.js';

test('validates well-formed expressions', () => {
  assert.ok(isValidCron('* * * * *'));
  assert.ok(isValidCron('0 9 * * 1-5'));
  assert.ok(isValidCron('*/15 * * * *'));
  assert.ok(isValidCron('0 3 * * sun'));
  assert.ok(isValidCron('30 6 1 jan *'));
  assert.ok(isValidCron('0 0,12 * * *'));
});

test('rejects malformed expressions', () => {
  assert.ok(!isValidCron('* * * *'));      // 4 fields
  assert.ok(!isValidCron('60 * * * *'));   // minute out of range
  assert.ok(!isValidCron('* 24 * * *'));   // hour out of range
  assert.ok(!isValidCron('* * 0 * *'));    // dom out of range
  assert.ok(!isValidCron('not a cron'));
  assert.ok(!isValidCron('*/0 * * * *'));  // zero step
});

test('parses field forms', () => {
  const p = parseCron('*/15 9-17 1,15 * mon-fri');
  assert.deepEqual([...p.minute], [0, 15, 30, 45]);
  assert.equal(p.hour.size, 9);
  assert.deepEqual([...p.dayOfMonth], [1, 15]);
  assert.deepEqual([...p.dayOfWeek], [1, 2, 3, 4, 5]);
});

test('normalizes day-of-week 7 to Sunday', () => {
  const p = parseCron('* * * * 7');
  assert.deepEqual([...p.dayOfWeek], [0]);
});

test('nextCron: daily time rolls to next day', () => {
  const next = nextCron('0 9 * * *', new Date('2026-06-09T10:30:00'));
  assert.equal(next.getDate(), 10);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
});

test('nextCron: weekday constraint skips weekend', () => {
  const next = nextCron('0 9 * * 1-5', new Date('2026-06-12T10:00:00')); // Friday
  assert.equal(next.getDay(), 1); // Monday
  assert.equal(next.getDate(), 15);
});

test('nextCron: step minutes', () => {
  const next = nextCron('*/15 * * * *', new Date('2026-06-09T10:07:00'));
  assert.equal(next.getMinutes(), 15);
});

test('nextCron: dom/dow OR semantics when both restricted', () => {
  // 13th of month OR Friday — from Tue Jun 9, Friday Jun 12 comes first
  const next = nextCron('0 0 13 * 5', new Date('2026-06-09T00:00:00'));
  assert.equal(next.getDate(), 12);
  assert.equal(next.getDay(), 5);
});

test('nextCron: dom AND dow when only one restricted', () => {
  const next = nextCron('0 0 13 * *', new Date('2026-06-09T00:00:00'));
  assert.equal(next.getDate(), 13);
});

test('nextCron: leap-year Feb 29', () => {
  const next = nextCron('0 0 29 2 *', new Date('2026-06-09T00:00:00'));
  assert.equal(next.getFullYear(), 2028);
  assert.equal(next.getMonth(), 1);
  assert.equal(next.getDate(), 29);
});
