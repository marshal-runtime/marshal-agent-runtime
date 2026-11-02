const ACCESS_STAFF = 'staff';
const BRAND_LABEL = /^brand:[a-z0-9][a-z0-9_-]{0,63}$/u;
const USER_LABEL = /^user:[a-z0-9][a-z0-9._+@-]{0,127}$/u;
const GROUP_LABEL = /^group:[a-z0-9][a-z0-9_-]{0,63}$/u;
const MAX_ACCESS_PRINCIPALS = 32;

export interface AccessPrincipals {
  readonly labels: readonly string[];
  readonly key: string;
}

const isAccessLabel = (value: unknown): value is string =>
  typeof value === 'string'
  && (value === ACCESS_STAFF || BRAND_LABEL.test(value) || USER_LABEL.test(value) || GROUP_LABEL.test(value));

/** The sorted, de-duplicated principals of a call: staff, brand:<id>, user:<email> or group:<name>. */
export function accessPrincipals(labels: readonly string[]): AccessPrincipals {
  if (!Array.isArray(labels) || labels.length > MAX_ACCESS_PRINCIPALS) {
    throw new TypeError(`Access principals must be a list of at most ${MAX_ACCESS_PRINCIPALS} labels.`);
  }
  if (labels.some((label) => !isAccessLabel(label))) {
    throw new TypeError('Access principals must be staff, brand:<id>, user:<email> or group:<name>.');
  }
  const sorted = Object.freeze([...new Set(labels)].sort());
  return Object.freeze({ labels: sorted, key: sorted.join(',') });
}
