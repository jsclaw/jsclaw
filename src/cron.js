/**
 * Minimal 5-field cron expression parser. Zero dependencies.
 * Fields: minute hour day-of-month month day-of-week
 * Supports: * lists(,) ranges(-) steps(/) and named months/days.
 * @module cron
 */

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 }, // 0 = Sunday (7 normalized to 0)
];

const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * Resolve a field token to a number, handling month/day names.
 * @param {string} token
 * @param {number} fieldIndex
 * @returns {number}
 */
function resolveValue(token, fieldIndex) {
  const lower = token.toLowerCase();
  if (fieldIndex === 3 && lower in MONTH_NAMES) return MONTH_NAMES[lower];
  if (fieldIndex === 4 && lower in DAY_NAMES) return DAY_NAMES[lower];
  const n = Number(token);
  if (!Number.isInteger(n)) throw new Error(`Invalid cron value: ${token}`);
  // Normalize day-of-week 7 to 0 (Sunday)
  if (fieldIndex === 4 && n === 7) return 0;
  return n;
}

/**
 * Parse a single cron field into a Set of matching values.
 * @param {string} field
 * @param {number} fieldIndex
 * @returns {Set<number>}
 */
function parseField(field, fieldIndex) {
  const { min, max } = FIELDS[fieldIndex];
  const values = new Set();

  for (const part of field.split(',')) {
    let [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid cron step: ${part}`);
    }

    let lo, hi;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = resolveValue(a, fieldIndex);
      hi = resolveValue(b, fieldIndex);
    } else {
      lo = resolveValue(range, fieldIndex);
      // Bare value with step (e.g. "5/15") extends to max; without step it's a single value
      hi = stepStr ? max : lo;
    }

    if (lo < min || hi > max || lo > hi) {
      throw new Error(`Cron value out of range [${min}-${max}]: ${part}`);
    }

    for (let v = lo; v <= hi; v += step) {
      values.add(v);
    }
  }

  return values;
}

/**
 * Parse a 5-field cron expression.
 * @param {string} expression - e.g. "0 9 * * 1-5"
 * @returns {{ minute: Set<number>, hour: Set<number>, dayOfMonth: Set<number>, month: Set<number>, dayOfWeek: Set<number> }}
 * @throws {Error} on invalid expressions
 */
export function parseCron(expression) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expression must have 5 fields, got ${parts.length}: "${expression}"`);
  }
  return {
    minute: parseField(parts[0], 0),
    hour: parseField(parts[1], 1),
    dayOfMonth: parseField(parts[2], 2),
    month: parseField(parts[3], 3),
    dayOfWeek: parseField(parts[4], 4),
  };
}

/**
 * Validate a cron expression.
 * @param {string} expression
 * @returns {boolean}
 */
export function isValidCron(expression) {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a Date matches a parsed cron expression.
 * Standard cron semantics: if both day-of-month and day-of-week are
 * restricted (not *), the date matches if EITHER matches.
 * @param {ReturnType<typeof parseCron>} parsed
 * @param {Date} date
 * @returns {boolean}
 */
function matches(parsed, date) {
  if (!parsed.minute.has(date.getMinutes())) return false;
  if (!parsed.hour.has(date.getHours())) return false;
  if (!parsed.month.has(date.getMonth() + 1)) return false;

  const domRestricted = parsed.dayOfMonth.size < 31;
  const dowRestricted = parsed.dayOfWeek.size < 7;
  const domMatch = parsed.dayOfMonth.has(date.getDate());
  const dowMatch = parsed.dayOfWeek.has(date.getDay());

  if (domRestricted && dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/**
 * Compute the next run time for a cron expression after a given date.
 * @param {string} expression - 5-field cron expression
 * @param {Date} [after] - Start point (default: now)
 * @returns {Date} Next matching time
 * @throws {Error} if no match within 4 years (malformed expression like Feb 30)
 */
export function nextCron(expression, after = new Date()) {
  const parsed = parseCron(expression);
  // Start at the next whole minute
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // 4 years of minutes covers leap-year-only expressions (Feb 29)
  const limit = 4 * 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (matches(parsed, candidate)) return candidate;

    // Skip ahead efficiently: if month doesn't match, jump to next month
    if (!parsed.month.has(candidate.getMonth() + 1)) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    // If neither day field can match today, jump to next day
    const domRestricted = parsed.dayOfMonth.size < 31;
    const dowRestricted = parsed.dayOfWeek.size < 7;
    const domMatch = parsed.dayOfMonth.has(candidate.getDate());
    const dowMatch = parsed.dayOfWeek.has(candidate.getDay());
    const dayOk = domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
    if (!dayOk) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    // If hour doesn't match, jump to next hour
    if (!parsed.hour.has(candidate.getHours())) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(`No matching time found for cron expression: ${expression}`);
}
