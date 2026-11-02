import type { InvocationContext } from '@marshal/agent-runtime-core';
import type {
  UiDeclaredToolDispatcherOptions,
  UiDeclaredToolInput,
  UiDeclaredToolResult,
} from './applicationTypes.js';
import { assertUiSchema } from './schemaValidation.js';

/** Server-authoritative dispatcher for tools bound to one immutable render manifest. */
export class UiDeclaredToolDispatcher {
  constructor(private readonly options: UiDeclaredToolDispatcherOptions) {}

  async invoke(
    input: UiDeclaredToolInput,
    context: InvocationContext,
  ): Promise<UiDeclaredToolResult> {
    if (context.signal?.aborted) throw cancelledError();
    const application = await this.options.loadApplication(input.renderId, context);
    if (!application) throw new Error(`Render ${input.renderId} has no declared application manifest`);
    const tool = application.tools.find((item) => item.id === input.toolId);
    if (!tool) throw new Error(`UI tool ${input.toolId} is not declared for render ${input.renderId}`);
    assertUiSchema(input.input ?? {}, tool.inputSchema, `tool.${tool.id}.input`);
    if (context.signal?.aborted) throw cancelledError();
    const executed = await this.options.executor.execute(tool, input.input ?? {}, context);
    if (context.signal?.aborted && executed.status !== 'cancelled') {
      return {
        status: 'cancelled',
        error: { code: 'ui_tool_cancelled', message: 'UI tool execution was cancelled.' },
        receipt: executed.receipt,
      };
    }
    if (executed.result?.output !== undefined && tool.outputSchema) {
      assertUiSchema(executed.result.output, tool.outputSchema, `tool.${tool.id}.output`);
    }
    return {
      status: executed.status,
      ...(executed.result?.output === undefined ? {} : { output: executed.result.output }),
      ...(executed.error ? { error: executed.error } : {}),
      ...(executed.approval ? { approval: executed.approval } : {}),
      ...(executed.receipt ? { receipt: executed.receipt } : {}),
    };
  }
}

function cancelledError(): Error {
  return Object.assign(new Error('UI tool execution was cancelled.'), { code: 'UI_TOOL_CANCELLED' });
}
