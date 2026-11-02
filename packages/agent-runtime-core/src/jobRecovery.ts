/**
 * Job metadata key holding the host's scalar invocation metadata (for example
 * a workspace name) so a recovered retry runs with the same host scope as the
 * original invocation. Approval evidence is never stored here.
 */
export const RECOVERABLE_INVOCATION_METADATA_KEY = 'invocationMetadata';

const MAX_ENTRIES = 32;
const MAX_KEY_LENGTH = 128;
const MAX_STRING_LENGTH = 1_024;

type ScalarMetadata = Readonly<Record<string, string | number | boolean>>;

const scalarEntries = (value: unknown): ScalarMetadata => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries: [string, string | number | boolean][] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (entries.length >= MAX_ENTRIES) break;
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) continue;
    if (typeof entry === 'string' && entry.length <= MAX_STRING_LENGTH) entries.push([key, entry]);
    else if (typeof entry === 'boolean' || (typeof entry === 'number' && Number.isFinite(entry))) {
      entries.push([key, entry]);
    }
  }
  return Object.fromEntries(entries);
};

/** Job-start metadata that lets recovery restore the invocation's scalar metadata. */
export const recoverableInvocationMetadata = (
  invocationMetadata: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, ScalarMetadata>> => {
  const scalars = scalarEntries(invocationMetadata);
  return Object.keys(scalars).length === 0 ? {} : { [RECOVERABLE_INVOCATION_METADATA_KEY]: scalars };
};

/** Invocation metadata saved by `recoverableInvocationMetadata`, revalidated on read. */
export const restoredInvocationMetadata = (
  jobMetadata: Readonly<Record<string, unknown>> | undefined,
): ScalarMetadata => scalarEntries(jobMetadata?.[RECOVERABLE_INVOCATION_METADATA_KEY]);
