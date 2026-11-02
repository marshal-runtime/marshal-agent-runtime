import type { JsonSchema } from '@marshal/agent-runtime-core';

/** Inclusive creation-time window for memory hits, in epoch milliseconds. */
export interface MemoryDateWindow {
  readonly after?: number;
  readonly before?: number;
}

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

export const CREATED_AFTER_SCHEMA: JsonSchema = {
  type: 'string',
  maxLength: 40,
  description: 'Only memory hits created at or after this ISO date (from 00:00 UTC) or timestamp. '
    + 'Code hits are not filtered.',
};

export const CREATED_BEFORE_SCHEMA: JsonSchema = {
  type: 'string',
  maxLength: 40,
  description: 'Only memory hits created at or before this ISO date (through 23:59:59.999 UTC) or '
    + 'timestamp. Code hits are not filtered.',
};

/**
 * Date.parse rolls impossible calendar dates over (2026-02-30 becomes March 2), so the written
 * components must survive a round trip: the date must exist and the clock must be in range.
 */
const calendarValid = (text: string): boolean => {
  const [, year, month, day, hour = '0', minute = '0', second = '0'] =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/u.exec(text) ?? [];
  if (year === undefined || month === undefined || day === undefined) return false;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day)
    && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59;
};

const bound = (value: unknown, field: 'createdAfter' | 'createdBefore'): number | undefined => {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value.trim() : '';
  const dateOnly = DATE_ONLY.test(text);
  const parsed = !calendarValid(text)
    ? Number.NaN
    : dateOnly
      ? Date.parse(`${text}T00:00:00.000Z`)
      : TIMESTAMP.test(text) ? Date.parse(text) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be an ISO 8601 date (YYYY-MM-DD) or timestamp with a time zone.`);
  }
  return dateOnly && field === 'createdBefore' ? parsed + DAY_MS - 1 : parsed;
};

/** The request's inclusive window, or undefined when it sets neither bound. */
export const parseMemoryDateWindow = (input: {
  readonly createdAfter?: unknown;
  readonly createdBefore?: unknown;
}): MemoryDateWindow | undefined => {
  const after = bound(input.createdAfter, 'createdAfter');
  const before = bound(input.createdBefore, 'createdBefore');
  if (after === undefined && before === undefined) return undefined;
  if (after !== undefined && before !== undefined && after > before) {
    throw new Error('createdAfter must not be later than createdBefore.');
  }
  return {
    ...(after === undefined ? {} : { after }),
    ...(before === undefined ? {} : { before }),
  };
};

/**
 * Code hits always pass. A memory hit passes when its creation time is inside the
 * window; a memory without a known creation time cannot be placed and does not.
 */
export const withinMemoryDateWindow = (
  node: { readonly kind: string; readonly createdAt?: string },
  window: MemoryDateWindow | undefined,
): boolean => {
  if (window === undefined || node.kind !== 'memory') return true;
  const created = node.createdAt === undefined ? Number.NaN : Date.parse(node.createdAt);
  if (!Number.isFinite(created)) return false;
  return (window.after === undefined || created >= window.after)
    && (window.before === undefined || created <= window.before);
};
