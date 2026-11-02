interface RuntimeContext {
  runtime: {
    search(query: unknown): Promise<{ matches: Array<{ capability: { name: string } }> }>;
    invoke(capability: string, input: unknown): Promise<unknown>;
  };
}

interface StudioInput {
  projectName: string;
  brief: string;
  sourceMaterial?: string;
}

interface Direction {
  id: string;
  name: string;
  premise: string;
  palette: [string, string, string];
  interaction: string;
}

interface Assignment {
  name: string;
  prompt: string;
}

interface DelegationOutcome {
  state?: string;
  result?: unknown;
}

interface DirectionValidationDiagnostic {
  code: string;
  message: string;
  observedCharacters?: number;
  normalizedCharacters?: number;
}

interface DirectionParseResult {
  direction?: Direction;
  diagnostics: DirectionValidationDiagnostic[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function delegationId(value: unknown): string | undefined {
  const id = asRecord(value)?.delegationId;
  return typeof id === 'string' ? id : undefined;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
    ? value.trim()
    : undefined;
}

function parseDirection(value: unknown, expectedId: string): DirectionParseResult {
  if (typeof value !== 'string') {
    return {
      diagnostics: [{
        code: 'direction-response-not-text',
        message: 'The successful child response did not contain text.',
      }],
    };
  }
  if (value.length > 20_000) {
    return {
      diagnostics: [{
        code: 'direction-response-too-large',
        message: 'The successful child response exceeded the 20,000-character parsing bound.',
        observedCharacters: Array.from(value).length,
      }],
    };
  }
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return {
      diagnostics: [{
        code: 'direction-json-object-missing',
        message: 'The successful child response did not contain a JSON object.',
      }],
    };
  }
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = asRecord(JSON.parse(value.slice(start, end + 1)));
  } catch {
    return {
      diagnostics: [{
        code: 'direction-json-invalid',
        message: 'The successful child response contained invalid JSON.',
      }],
    };
  }
  const name = boundedString(parsed?.name, 80);
  const premise = boundedString(parsed?.premise, 800);
  const interaction = normalizeInteraction(parsed?.interaction, 800);
  const palette = Array.isArray(parsed?.palette) ? parsed.palette : [];
  const diagnostics: DirectionValidationDiagnostic[] = [...interaction.diagnostics];
  if (!name) diagnostics.push({ code: 'direction-name-invalid', message: 'Direction name must contain 1-80 characters.' });
  if (!premise) diagnostics.push({ code: 'direction-premise-invalid', message: 'Direction premise must contain 1-800 characters.' });
  const paletteValid = palette.length === 3
    && palette.every((color) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color));
  if (!paletteValid) {
    diagnostics.push({
      code: 'direction-palette-invalid',
      message: 'Direction palette must contain exactly three #RRGGBB colors.',
    });
  }
  if (!name || !premise || !interaction.value || !paletteValid) return { diagnostics };
  return {
    direction: {
      id: expectedId,
      name,
      premise,
      palette: palette as [string, string, string],
      interaction: interaction.value,
    },
    diagnostics: interaction.diagnostics,
  };
}

function normalizeInteraction(value: unknown, maxLength: number): {
  value?: string;
  diagnostics: DirectionValidationDiagnostic[];
} {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {
      diagnostics: [{
        code: 'direction-interaction-invalid',
        message: `Direction interaction must contain 1-${maxLength} characters.`,
      }],
    };
  }
  const trimmed = value.trim();
  const characters = Array.from(trimmed);
  if (characters.length <= maxLength) return { value: trimmed, diagnostics: [] };
  const normalized = `${characters.slice(0, maxLength - 1).join('').trimEnd()}…`;
  return {
    value: normalized,
    diagnostics: [{
      code: 'direction-interaction-truncated',
      message: `Direction interaction exceeded ${maxLength} characters and was safely normalized.`,
      observedCharacters: characters.length,
      normalizedCharacters: Array.from(normalized).length,
    }],
  };
}

function delegationOutcome(value: unknown): DelegationOutcome {
  const record = asRecord(value);
  return {
    ...(typeof record?.state === 'string' ? { state: record.state } : {}),
    ...('result' in (record ?? {}) ? { result: record?.result } : {}),
  };
}

export default async function orchestrateDirections(input: StudioInput, context: RuntimeContext) {
  const discovery = await context.runtime.search({ query: 'delegation spawn wait', tags: ['delegation'] });
  const available = new Set(discovery.matches.map((match) => match.capability.name));
  const requiredCapabilities = [
    'runtime.delegation.spawn',
    'runtime.delegation.wait',
  ];
  const missingCapabilities = requiredCapabilities.filter((name) => !available.has(name));
  if (missingCapabilities.length > 0) {
    return {
      limitation: {
        code: 'delegation-capability-unavailable',
        message: 'The host does not expose delegation and completion observation.',
        missingCapabilities,
      },
      directions: [],
      synthesis: {
        status: 'limited',
        requested: 3,
        accepted: 0,
        succeeded: 0,
        usable: 0,
        complete: false,
      },
    };
  }

  const assignments: Assignment[] = [
    { name: 'systems', prompt: 'As a design systems specialist, propose a restrained system direction with tokens and accessibility constraints.' },
    { name: 'interaction', prompt: 'As an interaction designer, propose a task-focused interaction direction with direct manipulation and refinement controls.' },
    { name: 'editorial', prompt: 'As a visual designer, propose an editorial visual direction distinct from the other two while honoring the brief.' },
  ];
  const spawnAttempts = await Promise.allSettled(assignments.map((assignment) => context.runtime.invoke('runtime.delegation.spawn', {
    prompt: `${assignment.prompt}\nProject: ${input.projectName}\nBrief: ${input.brief}\nSource material: ${input.sourceMaterial ?? 'none supplied'}\nReturn exactly one JSON object with name (1-80 characters), premise (1-800 characters), palette (exactly three #RRGGBB colors), and interaction (1-800 characters). Do not wrap it in prose.`,
  })));
  const spawned = spawnAttempts.flatMap((attempt) =>
    attempt.status === 'fulfilled' ? [attempt.value] : []);
  const accepted = spawnAttempts.flatMap((attempt, index) => {
    if (attempt.status === 'rejected') return [];
    const id = delegationId(attempt.value);
    return id ? [{ id, assignment: assignments[index]! }] : [];
  });
  const spawnFailure = spawnAttempts.find((attempt) => attempt.status === 'rejected');
  const delegationIds = accepted.map((item) => item.id);
  if (delegationIds.length === 0) {
    if (spawnFailure?.status === 'rejected') throw spawnFailure.reason;
    return {
      assignments,
      spawned,
      synthesisInputs: {
        status: 'limited',
        limitation: {
          code: 'delegation-not-accepted',
          message: 'No delegation handle was accepted; synthesize locally or present the typed spawn limitations.',
        },
      },
      directions: [],
      synthesis: {
        status: 'limited',
        requested: assignments.length,
        accepted: 0,
        succeeded: 0,
        usable: 0,
        complete: false,
      },
    };
  }

  const waitAttempts = await Promise.allSettled(delegationIds.map((id) =>
    context.runtime.invoke('runtime.delegation.wait', { delegationId: id })));
  if (spawnFailure?.status === 'rejected') throw spawnFailure.reason;
  const waitFailure = waitAttempts.find((attempt) => attempt.status === 'rejected');
  if (waitFailure?.status === 'rejected') throw waitFailure.reason;
  const synthesisInputs = waitAttempts.flatMap((attempt) =>
    attempt.status === 'fulfilled' ? [attempt.value] : []);
  const outcomes = new Map(delegationIds.map((id, index) => [
    id,
    delegationOutcome(synthesisInputs[index]),
  ]));
  const parsedDirections = accepted.map(({ id, assignment }) => {
    const outcome = outcomes.get(id);
    const parsed = outcome?.state === 'done'
      ? parseDirection(outcome.result, assignment.name)
      : undefined;
    return { id, assignment, outcome, parsed };
  });
  const directions = parsedDirections.flatMap(({ parsed }) => parsed?.direction ? [parsed.direction] : []);
  const validationDiagnostics = parsedDirections.flatMap(({ id, assignment, outcome, parsed }) => (
    parsed?.diagnostics.map((diagnostic) => ({
      delegationId: id,
      assignment: assignment.name,
      outcomeState: outcome?.state ?? 'unknown',
      ...diagnostic,
    })) ?? []
  ));
  const succeeded = delegationIds.filter((id) => outcomes.get(id)?.state === 'done').length;
  const complete = accepted.length === assignments.length
    && directions.length === assignments.length
    && succeeded === assignments.length;
  const status = complete
    ? 'success'
    : succeeded > 0 || directions.length > 0
      ? 'partial'
      : 'limited';
  return {
    assignments,
    spawned,
    synthesisInputs,
    directions,
    validationDiagnostics,
    synthesis: {
      status,
      requested: assignments.length,
      accepted: delegationIds.length,
      succeeded,
      usable: directions.length,
      complete,
    },
  };
}
