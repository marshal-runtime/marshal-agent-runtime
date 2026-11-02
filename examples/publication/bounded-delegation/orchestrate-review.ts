interface RuntimeContext {
  runtime: {
    search(query: unknown): Promise<{ matches: Array<{ capability: { name: string } }> }>;
    invoke(capability: string, input: unknown): Promise<unknown>;
  };
}

interface ReviewInput {
  subject: string;
  prompts: Array<{ name: string; prompt: string }>;
}

function delegationId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>).delegationId;
  return typeof id === 'string' ? id : undefined;
}

export default async function orchestrateReview(input: ReviewInput, context: RuntimeContext) {
  if (input.prompts.length === 0) {
    throw new RangeError('Provide at least one review prompt.');
  }
  const discovery = await context.runtime.search({
    query: 'native agent delegation spawn wait',
    tags: ['delegation'],
  });
  const names = new Set(discovery.matches.map((match) => match.capability.name));
  for (const required of ['runtime.delegation.spawn', 'runtime.delegation.wait']) {
    if (!names.has(required)) throw new Error(`${required} is not discoverable in this host.`);
  }

  const spawnAttempts = await Promise.allSettled(input.prompts.map((item) =>
    context.runtime.invoke('runtime.delegation.spawn', {
      prompt: `${item.prompt}\nSubject: ${input.subject}`,
    })));
  const spawned = spawnAttempts.flatMap((attempt) =>
    attempt.status === 'fulfilled' ? [attempt.value] : []);
  const delegationIds = spawned
    .map(delegationId)
    .filter((id): id is string => id !== undefined);
  const waitAttempts = await Promise.allSettled(delegationIds.map((id) =>
    context.runtime.invoke('runtime.delegation.wait', { delegationId: id })));
  const spawnFailure = spawnAttempts.find((attempt) => attempt.status === 'rejected');
  if (spawnFailure?.status === 'rejected') throw spawnFailure.reason;
  const waitFailure = waitAttempts.find((attempt) => attempt.status === 'rejected');
  if (waitFailure?.status === 'rejected') throw waitFailure.reason;
  const waited = waitAttempts.flatMap((attempt) =>
    attempt.status === 'fulfilled' ? [attempt.value] : []);

  return { spawned, waited };
}
