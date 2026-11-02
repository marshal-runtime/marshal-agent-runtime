import { InMemoryLifecycle, InMemoryRuntimeKernel } from '../../testing/inMemoryRuntime.js';

export default function createFakeRuntimeBindings() {
  const provider = {
    list: () => [
      {
        name: 'test.echo',
        version: '1.0.0',
        description: 'Echo input through the stdio integration fixture',
      },
    ],
    invoke: async (_name: string, input: unknown) => ({ echoed: input }),
  };
  return {
    kernel: new InMemoryRuntimeKernel([provider], async (request) => ({
      executedSource: request.source,
      input: request.input,
    })),
    lifecycle: new InMemoryLifecycle({
      startSession: () => ({ memoryContext: ['stdio fixture memory'] }),
      observeTurn: () => ({ stored: true }),
      endSession: () => ({ flushed: true }),
    }),
  };
}
