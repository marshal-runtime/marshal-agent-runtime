import { projectLifecycleBriefing } from '@marshal/agent-runtime-manifest';

export interface RuntimeSessionBriefingOptions {
  /** Harness-visible capability discovery entry point. */
  readonly discoveryEntryPoint?: string;
  /** Harness-visible operation and module execution entry point. */
  readonly executionEntryPoint?: string;
  /** Harness-visible compiled React display entry point. */
  readonly renderComponentEntryPoint?: string;
  /** Optional extension-provided briefing, bounded before projection. */
  readonly additionalBriefing?: string;
}

const MAX_ENTRY_POINT_LENGTH = 128;
const MAX_ADDITIONAL_BRIEFING_LENGTH = 1_024;

/**
 * Compact harness-neutral context projected from the versioned capability
 * manifest. Adapters provide only their visible entry-point names.
 */
export function createRuntimeSessionBriefing(
  options: RuntimeSessionBriefingOptions = {},
): string {
  const lifecycleBriefing = projectLifecycleBriefing({
    discovery: boundedEntryPoint(options.discoveryEntryPoint, 'discoveryEntryPoint'),
    execution: boundedEntryPoint(options.executionEntryPoint, 'executionEntryPoint'),
    renderComponent: boundedEntryPoint(
      options.renderComponentEntryPoint,
      'renderComponentEntryPoint',
    ),
  });
  const additionalBriefing = boundedAdditionalBriefing(options.additionalBriefing);
  return [lifecycleBriefing, additionalBriefing].filter(Boolean).join('\n\n');
}

function boundedEntryPoint(value: string | undefined, field: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > MAX_ENTRY_POINT_LENGTH) {
    throw new Error(`${field} must be at most ${MAX_ENTRY_POINT_LENGTH} characters.`);
  }
  return normalized;
}

function boundedAdditionalBriefing(
  value: string | undefined,
  field = 'additionalBriefing',
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > MAX_ADDITIONAL_BRIEFING_LENGTH) {
    throw new Error(`${field} must be at most ${MAX_ADDITIONAL_BRIEFING_LENGTH} characters.`);
  }
  return normalized;
}
