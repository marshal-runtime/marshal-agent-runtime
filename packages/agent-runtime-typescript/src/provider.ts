import { DirectTypeScriptExecutor } from './executor.js';
import type { InlineModuleExecutionProvider, TypeScriptExecutorOptions } from './types.js';

/**
 * Creates a workflow-free provider that a runtime kernel can register for the
 * `inline_module` target type. Both `execute` and `invoke` are exposed so hosts
 * can adapt it to either an executor registry or a capability-provider shape.
 */
export function createInlineModuleExecutionProvider(
  options: TypeScriptExecutorOptions = {},
): InlineModuleExecutionProvider {
  const executor = new DirectTypeScriptExecutor(options);
  const execute: InlineModuleExecutionProvider['execute'] = (request, context) =>
    executor.execute(request, context);
  return Object.freeze({
    id: 'inline_module',
    targetType: 'inline_module',
    execute,
    invoke: execute,
    dispose: () => executor.dispose(),
  });
}

export const createInlineModuleExecutor = createInlineModuleExecutionProvider;
