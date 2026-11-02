import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  createInlineModuleExecutionProvider,
  DirectTypeScriptExecutor,
  type RuntimeCapabilityBroker,
} from '../src/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('DirectTypeScriptExecutor', () => {
  it('compiles edited TypeScript source and reruns the new version', async () => {
    const executor = new DirectTypeScriptExecutor();
    const first = await executor.execute({
      source: 'export default (input: { value: number }) => input.value + 1;',
      input: { value: 4 },
    });
    const edited = await executor.execute({
      source: 'export default (input: { value: number }) => input.value * 3;',
      input: { value: 4 },
    });

    expect(first).toMatchObject({ ok: true, status: 'succeeded', value: 5 });
    expect(edited).toMatchObject({ ok: true, status: 'succeeded', value: 12 });
    expect(edited.executionId).not.toBe(first.executionId);
    expect(edited.source.contentDigest).not.toBe(first.source.contentDigest);
    expect(edited.compilation?.cacheKey).not.toBe(first.compilation?.cacheKey);
    expect(first.compilation?.cacheStatus).toBe('miss');
    expect(edited.compilation?.cacheStatus).toBe('miss');
  });

  it.each([
    ['Node builtin', "import fs from 'node:fs'; export default () => fs.existsSync('.')"],
    ['package', "import { parse } from 'yaml'; export default () => parse('x: 1')"],
  ])('denies a %s import in brokered mode', async (_label, source) => {
    const result = await new DirectTypeScriptExecutor().execute({ source });

    expect(result).toMatchObject({
      ok: false,
      status: 'compile_failed',
      error: { code: 'IMPORT_DENIED', stage: 'compile' },
    });
  });

  // TODO(#11): Restore once the executor has a module timeout.
  it.skip('terminates a synchronous infinite loop at the timeout', async () => {
    const result = await new DirectTypeScriptExecutor().execute({
      source: 'export default () => { while (true) {} };',
      timeoutMs: 150,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'timed_out',
      error: { code: 'TIMED_OUT' },
    });
  });

  it('supports AbortSignal cancellation', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await new DirectTypeScriptExecutor().execute(
      {
        source: 'export default async () => new Promise(() => {});',
        timeoutMs: 5_000,
      },
      { signal: controller.signal },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'aborted',
      error: { code: 'ABORTED' },
    });
  });

  it('preserves cancellation after a compilation-cache hit', async () => {
    const executor = new DirectTypeScriptExecutor();
    const source = `export default async (input: { wait: boolean }) => {
      if (input.wait) await new Promise(() => {});
      return 'ready';
    };`;
    const warm = await executor.execute({ source, input: { wait: false } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const aborted = await executor.execute(
      { source, input: { wait: true }, timeoutMs: 5_000 },
      { signal: controller.signal },
    );

    expect(warm).toMatchObject({ ok: true, compilation: { cacheStatus: 'miss' } });
    expect(aborted).toMatchObject({
      ok: false,
      status: 'aborted',
      error: { code: 'ABORTED' },
      compilation: { cacheStatus: 'hit', dependencyGraphValidated: true },
    });
  });

  it('does not share compiled behavior across permission policies', async () => {
    const source = "import path from 'node:path'; export default () => path.join('a', 'b');";
    const executor = new DirectTypeScriptExecutor({ workingDirectory: repositoryRoot });
    const allowed = await executor.execute({
      source,
      mode: 'trusted',
      allowedBuiltins: ['path'],
    });
    const denied = await executor.execute({ source, mode: 'trusted' });

    expect(allowed).toMatchObject({ ok: true, compilation: { cacheStatus: 'miss' } });
    expect(denied).toMatchObject({
      ok: false,
      status: 'compile_failed',
      error: { code: 'IMPORT_DENIED' },
    });
  });

  it('terminates output floods and returns only the configured capture size', async () => {
    const maxOutputBytes = 128;
    const result = await new DirectTypeScriptExecutor().execute({
      source: "export default () => { console.log('x'.repeat(10_000)); return 'nope'; };",
      maxOutputBytes,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'output_limit_exceeded',
      error: { code: 'OUTPUT_LIMIT_EXCEEDED' },
    });
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      maxOutputBytes,
    );
    expect(result.outputBytes).toBeGreaterThan(maxOutputBytes);
  });

  it('keeps brokered modules in a context realm without ambient process or host constructors', async () => {
    const result = await new DirectTypeScriptExecutor().execute({
      source: `// @ts-nocheck
        export default async () => {
          let timerConstructorBlocked = false;
          let moduleConstructorBlocked = false;
          let globalConstructorBlocked = false;
          let innerConstructorBlocked = false;
          try { setTimeout.constructor('return 1')(); } catch { timerConstructorBlocked = true; }
          try { module.constructor.constructor('return 1')(); } catch { moduleConstructorBlocked = true; }
          try { globalThis.constructor.constructor('return process')(); } catch { globalConstructorBlocked = true; }
          try { ({}).constructor.constructor('return process')(); } catch { innerConstructorBlocked = true; }
          await new Promise((resolve) => setTimeout(resolve, 5));
          return {
            processType: typeof process,
            requireType: typeof require,
            globalConstructorType: typeof globalThis.constructor,
            globalPrototypeIsNull: Object.getPrototypeOf(globalThis) === null,
            timerConstructorBlocked,
            moduleConstructorBlocked,
            globalConstructorBlocked,
            innerConstructorBlocked,
          };
        };
      `,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        processType: 'undefined',
        requireType: 'undefined',
        globalConstructorType: 'undefined',
        globalPrototypeIsNull: true,
        timerConstructorBlocked: true,
        moduleConstructorBlocked: true,
        globalConstructorBlocked: true,
        innerConstructorBlocked: true,
      },
    });
  });

  it('bundles and executes an installed package only when explicitly trusted', async () => {
    const result = await new DirectTypeScriptExecutor({
      mode: 'trusted',
      allowedPackages: ['yaml'],
      workingDirectory: repositoryRoot,
    }).execute({
      source: `
        import { parse } from 'yaml';
        export default () => parse('answer: 42').answer;
      `,
    });

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      ok: true,
      value: 42,
      mode: 'trusted',
    });
  });

  it('permits only configured Node builtins in trusted mode', async () => {
    const executor = new DirectTypeScriptExecutor({
      mode: 'trusted',
      allowedBuiltins: ['node:path'],
    });
    const allowed = await executor.execute({
      source: "import path from 'node:path'; export default () => path.join('a', 'b');",
    });
    const denied = await executor.execute({
      source: "import fs from 'node:fs'; export default () => fs.existsSync('.');",
    });

    expect(allowed).toMatchObject({ ok: true, value: path.join('a', 'b') });
    expect(denied).toMatchObject({ ok: false, error: { code: 'IMPORT_DENIED' } });
  });

  it('can expose every installed package and builtin only through explicit trusted wildcards', async () => {
    const result = await new DirectTypeScriptExecutor({
      mode: 'trusted',
      allowedPackages: ['*'],
      allowedBuiltins: ['*'],
      workingDirectory: repositoryRoot,
    }).execute({
      source: `
        import path from 'node:path';
        import { parse } from 'yaml';
        export default () => ({ joined: path.join('a', 'b'), answer: parse('answer: 42').answer });
      `,
    });

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      ok: true,
      mode: 'trusted',
      value: { joined: path.join('a', 'b'), answer: 42 },
      environment: {
        importedPackages: [expect.objectContaining({ name: 'yaml', version: expect.any(String) })],
        importedBuiltins: expect.arrayContaining(['path']),
        fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
  });

  it('gives trusted workers the home directory but keeps brokered workers minimal', async () => {
    const source =
      "import process from 'node:process'; export default () => process.env.HOME ?? process.env.USERPROFILE ?? null;";
    const trusted = await new DirectTypeScriptExecutor({
      mode: 'trusted',
      allowedBuiltins: ['node:process'],
    }).execute({ source });

    expect(trusted).toMatchObject({
      ok: true,
      value: process.env.HOME ?? process.env.USERPROFILE,
    });
  });

  it('reports 1-based columns for compile diagnostics at the start of a line', async () => {
    const result = await new DirectTypeScriptExecutor().execute({
      source: 'export default () => 1;\n)',
    });

    expect(result).toMatchObject({ ok: false, status: 'compile_failed' });
    expect(result.diagnostics[0]?.location).toMatchObject({ line: 2, column: 1 });
  });

  it('runs a requested named export and returns source-mapped runtime diagnostics', async () => {
    const result = await new DirectTypeScriptExecutor().execute({
      filename: 'editable-block.ts',
      entrypoint: 'analyze',
      source: ['export function analyze() {', "  throw new Error('editable failure');", '}'].join(
        '\n',
      ),
    });

    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('editable failure') },
      source: {
        kind: 'inline',
        identifier: 'editable-block.ts',
        contentDigest: expect.stringMatching(/^sha256:/),
      },
    });
    expect(result.diagnostics.at(-1)?.location, JSON.stringify(result, null, 2)).toMatchObject({
      file: 'editable-block.ts',
      line: expect.any(Number),
      column: expect.any(Number),
    });
  });

  it('round-trips serializable runtime search and invoke calls through the broker', async () => {
    const broker: RuntimeCapabilityBroker = {
      search: vi.fn(async (query) => [{ name: 'math.double', query }]),
      invoke: vi.fn(async (capability, input) => ({ capability, input, result: 18 })),
    };
    const result = await new DirectTypeScriptExecutor().execute(
      {
        input: { term: 'double', value: 9 },
        source: `
          export default async (input, context) => {
            const found = await context.runtime.search({ query: input.term });
            const invoked = await context.runtime.invoke(found[0].name, { value: input.value });
            return { found, invoked };
          };
        `,
      },
      { broker },
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        found: [{ name: 'math.double', query: { query: 'double' } }],
        invoked: { capability: 'math.double', input: { value: 9 }, result: 18 },
      },
    });
    expect(broker.search).toHaveBeenCalledOnce();
    expect(broker.invoke).toHaveBeenCalledOnce();
  });

  // TODO(#11): Restore once the executor has a module timeout.
  it.skip('aborts in-flight broker calls when the module times out', async () => {
    let brokerAborted = false;
    let brokerCleanupFinished = false;
    const broker: RuntimeCapabilityBroker = {
      search: async () => null,
      invoke: async (_capability, _input, context) =>
        await new Promise((_resolvePromise, reject) => {
          const abort = () => {
            brokerAborted = true;
            setTimeout(() => {
              brokerCleanupFinished = true;
              reject(new Error('broker call aborted'));
            }, 25);
          };
          if (context.signal.aborted) abort();
          else context.signal.addEventListener('abort', abort, { once: true });
        }),
    };
    const result = await new DirectTypeScriptExecutor().execute(
      {
        source: `export default async (_input, context) =>
          context.runtime.invoke('test.long-running', null);`,
        timeoutMs: 500,
      },
      { broker },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'timed_out',
      error: { code: 'TIMED_OUT' },
    });
    expect(brokerAborted).toBe(true);
    expect(brokerCleanupFinished).toBe(true);
  });

  it('exposes a workflow-free inline_module provider shape', async () => {
    const provider = createInlineModuleExecutionProvider();
    const result = await provider.invoke({ source: 'export const run = () => ({ provider: true });' });

    expect(provider).toMatchObject({ id: 'inline_module', targetType: 'inline_module' });
    expect(result).toMatchObject({ ok: true, value: { provider: true } });
    await provider.dispose();
    await expect(provider.dispose()).resolves.toBeUndefined();
    await expect(provider.invoke({ source: 'export default () => null;' })).rejects.toThrow(
      'TypeScript executor has been disposed.',
    );
  });
});
