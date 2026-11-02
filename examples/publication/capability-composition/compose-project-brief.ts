interface RuntimeContext {
  runtime: {
    search(query: unknown): Promise<{ matches: Array<{ capability: { name: string } }> }>;
    invoke(capability: string, input: unknown): Promise<unknown>;
  };
}

interface ComposeInput {
  memoryQuery: string;
  artifactPath: string;
}

export default async function composeProjectBrief(input: ComposeInput, context: RuntimeContext) {
  const discovery = await context.runtime.search({
    tags: ['memory'],
    query: 'search durable project memory',
    limit: 5,
  });
  if (!discovery.matches.some((match) => match.capability.name === 'memory.search')) {
    throw new Error('memory.search was not discoverable in the current runtime.');
  }

  const memory = await context.runtime.invoke('memory.search', {
    scope: 'project',
    query: input.memoryQuery,
    limit: 5,
  });
  const content = JSON.stringify({ generatedFrom: 'memory.search', memory }, null, 2);
  const artifact = await context.runtime.invoke('artifacts.write', {
    path: input.artifactPath,
    scope: 'project',
    content,
    mediaType: 'application/json',
    overwrite: true,
  });
  return { memory, artifact };
}
