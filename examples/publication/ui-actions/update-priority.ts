interface RuntimeContext {
  runtime: { invoke(capability: string, input: unknown): Promise<unknown> };
}

interface PriorityInput {
  itemId: string;
  priority: string;
}

export default async function updatePriority(input: PriorityInput, context: RuntimeContext) {
  if (!input.itemId.trim() || !input.priority.trim()) throw new TypeError('itemId and priority are required.');
  const record = {
    itemId: input.itemId,
    priority: input.priority,
    source: 'editable-module-action',
  };
  const artifact = await context.runtime.invoke('artifacts.write', {
    path: `publication/priorities/${input.itemId}.json`,
    scope: 'project',
    content: JSON.stringify(record, null, 2),
    mediaType: 'application/json',
    overwrite: true,
  });
  return { updated: true, record, artifact };
}
