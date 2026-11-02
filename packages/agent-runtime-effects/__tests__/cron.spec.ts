import { describe, expect, it } from 'vitest';
import { nextCronTime, parseCron } from '../src/index.js';

const NEW_YORK = 'America/New_York';
const JERUSALEM = 'Asia/Jerusalem';
const UTC = 'UTC';

const next = (expression: string, after: string, zone = UTC) =>
  nextCronTime(expression, new Date(after), zone)?.toISOString();

describe('nextCronTime', () => {
  it('finds the next slot for steps, lists and ranges', () => {
    expect(next('*/15 * * * *', '2026-10-26T10:07:00Z')).toBe('2026-10-26T10:15:00.000Z');
    expect(next('0 9,17 * * *', '2026-10-26T10:00:00Z')).toBe('2026-10-26T17:00:00.000Z');
    expect(next('30 8 * * 1-5', '2026-10-24T12:00:00Z')).toBe('2026-10-26T08:30:00.000Z');
    expect(next('5/20 * * * *', '2026-10-26T10:06:00Z')).toBe('2026-10-26T10:25:00.000Z');
  });

  it('is strictly after the given instant', () => {
    expect(next('0 10 * * *', '2026-10-26T10:00:00Z')).toBe('2026-10-27T10:00:00.000Z');
  });

  it('honours the time zone including its offset', () => {
    expect(next('0 9 * * *', '2026-10-26T00:00:00Z', JERUSALEM)).toBe('2026-10-26T07:00:00.000Z');
    expect(next('0 9 * * *', '2026-11-02T00:00:00Z', JERUSALEM)).toBe('2026-11-02T07:00:00.000Z');
  });

  it('skips a wall-clock time that daylight saving removes', () => {
    expect(next('30 2 * * *', '2026-03-07T12:00:00Z', NEW_YORK)).toBe('2026-03-09T06:30:00.000Z');
  });

  it('takes the first of two occurrences when the clock repeats', () => {
    expect(next('30 1 * * *', '2026-10-31T12:00:00Z', NEW_YORK)).toBe('2026-11-01T05:30:00.000Z');
    expect(next('30 1 * * *', '2026-11-01T05:31:00Z', NEW_YORK)).toBe('2026-11-02T06:30:00.000Z');
  });

  it('matches either day field when both are restricted, and both otherwise', () => {
    expect(next('0 0 13 * 5', '2026-10-26T00:00:00Z')).toBe('2026-10-30T00:00:00.000Z');
    expect(next('0 0 * * 0', '2026-10-26T00:00:00Z')).toBe('2026-11-01T00:00:00.000Z');
    expect(next('0 0 * * 7', '2026-10-26T00:00:00Z')).toBe('2026-11-01T00:00:00.000Z');
  });

  it('reaches a leap day and gives up on an impossible date', () => {
    expect(next('0 0 29 2 *', '2026-10-26T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
    expect(next('0 0 31 2 *', '2026-10-26T00:00:00Z')).toBeUndefined();
  });

  it.each([
    ['', 'five fields'],
    ['* * * *', 'five fields'],
    ['60 * * * *', 'outside'],
    ['* 24 * * *', 'outside'],
    ['*/0 * * * *', 'step'],
    ['5-1 * * * *', 'reversed'],
    ['a * * * *', 'invalid'],
  ])('rejects "%s"', (expression, message) => {
    expect(() => parseCron(expression)).toThrow(message);
  });

  it('rejects an unknown time zone', () => {
    expect(() => nextCronTime('* * * * *', new Date(), 'Mars/Base')).toThrow('IANA');
  });
});
