const HOURS_PER_DAY = 24;
const MS_PER_DAY = 86_400_000;
const SEARCH_YEARS = 8;
const SEARCH_DAYS = 366 * SEARCH_YEARS;
const DEFAULT_TIME_ZONE = 'UTC';
const CRON_FIELD_COUNT = 5;
const SUNDAY_ALIAS = 7;

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

const MINUTE_FIELD: FieldSpec = { name: 'minute', min: 0, max: 59 };
const HOUR_FIELD: FieldSpec = { name: 'hour', min: 0, max: 23 };
const DAY_OF_MONTH_FIELD: FieldSpec = { name: 'day of month', min: 1, max: 31 };
const MONTH_FIELD: FieldSpec = { name: 'month', min: 1, max: 12 };
const DAY_OF_WEEK_FIELD: FieldSpec = { name: 'day of week', min: 0, max: 7 };

export interface ParsedCron {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/** Parses a five-field cron expression: minute hour day-of-month month day-of-week. */
export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== CRON_FIELD_COUNT) {
    throw new TypeError('cron expression must have exactly five fields.');
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const weekdays = expandField(dayOfWeek, DAY_OF_WEEK_FIELD).map((day) =>
    day === SUNDAY_ALIAS ? 0 : day,
  );
  return {
    minutes: expandField(minute, MINUTE_FIELD),
    hours: expandField(hour, HOUR_FIELD),
    daysOfMonth: new Set(expandField(dayOfMonth, DAY_OF_MONTH_FIELD)),
    months: new Set(expandField(month, MONTH_FIELD)),
    daysOfWeek: new Set(weekdays),
    dayOfMonthRestricted: !dayOfMonth.startsWith('*'),
    dayOfWeekRestricted: !dayOfWeek.startsWith('*'),
  };
}

/** Returns the first matching instant strictly after `after`, or undefined when none exists within eight years. */
export function nextCronTime(
  expression: string,
  after: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
): Date | undefined {
  assertTimeZone(timeZone);
  const cron = parseCron(expression);
  const startLocal = localParts(after, timeZone);
  const startDay = Date.UTC(startLocal.year, startLocal.month - 1, startLocal.day);
  for (let offset = 0; offset < SEARCH_DAYS; offset += 1) {
    const day = new Date(startDay + offset * MS_PER_DAY);
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth() + 1;
    const dayOfMonth = day.getUTCDate();
    if (!cron.months.has(month) || !dayMatches(cron, day)) continue;
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const instant = zonedInstant({ year, month, day: dayOfMonth, hour, minute }, timeZone);
        if (instant !== undefined && instant.getTime() > after.getTime()) return instant;
      }
    }
  }
  return undefined;
}

export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new TypeError(`timing.timezone "${timeZone}" is not a valid IANA time zone.`);
  }
}

function dayMatches(cron: ParsedCron, day: Date): boolean {
  const monthDay = cron.daysOfMonth.has(day.getUTCDate());
  const weekDay = cron.daysOfWeek.has(day.getUTCDay());
  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) return monthDay || weekDay;
  return monthDay && weekDay;
}

function expandField(field: string, spec: FieldSpec): number[] {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [range = '', stepText] = part.split('/');
    const step = stepText === undefined ? 1 : parseNumber(stepText, spec, true);
    const [from, to] = rangeBounds(range, spec, stepText !== undefined);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  if (values.size === 0) throw new TypeError(`cron ${spec.name} field is empty.`);
  return [...values].sort((left, right) => left - right);
}

function rangeBounds(range: string, spec: FieldSpec, hasStep: boolean): [number, number] {
  if (range === '*') return [spec.min, spec.max === SUNDAY_ALIAS ? 6 : spec.max];
  const [fromText = '', toText] = range.split('-');
  const from = parseNumber(fromText, spec, false);
  if (toText !== undefined) {
    const to = parseNumber(toText, spec, false);
    if (to < from) throw new TypeError(`cron ${spec.name} range ${range} is reversed.`);
    return [from, to];
  }
  return [from, hasStep ? (spec.max === SUNDAY_ALIAS ? 6 : spec.max) : from];
}

function parseNumber(text: string, spec: FieldSpec, isStep: boolean): number {
  if (!/^\d+$/.test(text)) throw new TypeError(`cron ${spec.name} value "${text}" is invalid.`);
  const value = Number(text);
  if (isStep) {
    if (value < 1) throw new TypeError(`cron ${spec.name} step must be at least 1.`);
    return value;
  }
  if (value < spec.min || value > spec.max) {
    throw new TypeError(`cron ${spec.name} value ${value} is outside ${spec.min}-${spec.max}.`);
  }
  return value;
}

function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(instant);
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % HOURS_PER_DAY,
    minute: read('minute'),
  };
}

function wallClockMillis(parts: LocalParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

/** Converts a wall-clock time to an instant; undefined when DST skips that time. Ambiguous times take the first occurrence. */
function zonedInstant(wall: LocalParts, timeZone: string): Date | undefined {
  const wanted = wallClockMillis(wall);
  const candidates = new Set<number>();
  for (const probe of [wanted - MS_PER_DAY / 2, wanted, wanted + MS_PER_DAY / 2]) {
    const offset = wallClockMillis(localParts(new Date(probe), timeZone)) - probe;
    candidates.add(wanted - offset);
  }
  const matches = [...candidates]
    .filter((millis) => wallClockMillis(localParts(new Date(millis), timeZone)) === wanted)
    .sort((left, right) => left - right);
  const first = matches[0];
  return first === undefined ? undefined : new Date(first);
}
