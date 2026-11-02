import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runnerArguments = process.argv.slice(2);
const initializeCodeIndex = runnerArguments.includes('--initialize-code-index');
const workspacePath = resolve(
  runnerArguments.find((argument) => !argument.startsWith('--')) ?? repositoryRoot,
);
const nonce = randomUUID().replaceAll('-', '');
const sourceDirectory = join(workspacePath, `.marshal-acceptance-${nonce}`);
const stateDirectory = `.marshal/acceptance-${nonce}`;
const stateRoot = join(workspacePath, stateDirectory);
const worktreeRoot = await mkdtemp(join(tmpdir(), 'marshal-runtime-worktrees-'));
const protectedRoot = await mkdtemp(join(tmpdir(), 'marshal-runtime-protected-'));
const sessionId = `acceptance-${nonce}`;
const memoryMarker = `MARSHAL_ACCEPTANCE_${nonce}`;
const cli = join(repositoryRoot, 'packages', 'agent-runtime-codex', 'dist', 'cli.js');
const bindings = join(repositoryRoot, 'scripts', 'acceptance-bindings.mjs');
const componentPath = join(sourceDirectory, 'AcceptancePanel.tsx');
const modulePath = join(sourceDirectory, 'editable.ts');
const cleanup = [sourceDirectory, stateRoot, worktreeRoot, protectedRoot];

await mkdir(sourceDirectory, { recursive: false });
await writeFile(
  componentPath,
  `export default function AcceptancePanel(props) { return <section data-runtime-acceptance="true"><h1>{props.title}</h1><p>{props.count}</p></section>; }\n`,
);
await writeFile(modulePath, 'export default (input) => ({ revision: 1, value: input.value });\n');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, '--kernel-module', bindings, '--workspace', workspacePath],
  cwd: repositoryRoot,
  env: {
    ...process.env,
    MARSHAL_ACCEPTANCE_STATE_DIRECTORY: stateDirectory,
    MARSHAL_ACCEPTANCE_WORKTREE_ROOT: worktreeRoot,
    MARSHAL_ACCEPTANCE_PROTECTED_ROOT: protectedRoot,
  },
  stderr: 'pipe',
});
const client = new Client({ name: 'marshal-runtime-acceptance', version: '1.0.0' });
const report = {};

try {
  await client.connect(transport);
  const initialTools = await client.listTools();
  assert(
    initialTools.tools.some((tool) => tool.name === 'runtime_render_component'),
    'Stable compiled React display tool was not registered at task start.',
  );
  await call('runtime_session_start', {
    protocolVersion: '1.0.0',
    eventId: `${nonce}:start`,
    sessionId,
  });

  for (const name of [
    'memory.store',
    'attachments.convert',
    'code.index.status',
    'ui.compile',
    'runtime.delegation.spawn',
    'runtime.delegation.continue',
    'runtime.delegation.wait',
    'runtime.delegation.cancel',
  ]) {
    const result = await call('runtime_search', {
      protocolVersion: '1.0.0',
      name,
      query: 'deliberately unrelated exact lookup',
      context: { sessionId },
    });
    const matches = result.matches;
    assert(Array.isArray(matches) && matches.length === 1, `Exact lookup failed for ${name}.`);
  }
  report.exactLookup = 'passed';

  assertSuccess(await execute('memory.store', {
    scope: 'session',
    content: memoryMarker,
    tags: ['acceptance'],
  }), 'memory.store');
  const recalled = assertSuccess(await execute('memory.search', {
    scope: 'session',
    query: memoryMarker,
    limit: 5,
  }), 'memory.search');
  assert(JSON.stringify(recalled).includes(memoryMarker), 'Durable memory marker was not recalled.');
  report.memory = 'passed';

  const moduleRequest = {
    protocolVersion: '1.0.0',
    targetType: 'module',
    module: { kind: 'workspace_file', path: relative(workspacePath, modulePath).replaceAll('\\', '/') },
    input: { value: 7 },
    context: { sessionId },
  };
  const firstModule = await call('runtime_exec', moduleRequest);
  assert(firstModule.status === 'success', 'Initial workspace module execution failed.');
  assert(firstModule.result?.output?.value?.revision === 1, 'Initial module revision was not executed.');
  await writeFile(modulePath, 'export default (input) => ({ revision: 2, value: input.value * 2 });\n');
  const secondModule = await call('runtime_exec', moduleRequest);
  assert(secondModule.status === 'success', 'Edited workspace module execution failed.');
  assert(secondModule.result?.output?.value?.revision === 2, 'Edited module was not reloaded.');
  assert(
    firstModule.result?.output?.source?.contentDigest !== secondModule.result?.output?.source?.contentDigest,
    'Edited module did not produce a new content digest.',
  );
  report.editableModule = 'passed';

  const compiled = assertSuccess(await execute('ui.compile', {
    entryPath: relative(workspacePath, componentPath).replaceAll('\\', '/'),
    title: 'Runtime acceptance panel',
  }), 'ui.compile');
  const componentId = compiled.component?.id;
  assert(typeof componentId === 'string', 'React UI compilation returned no component ID.');
  const rendered = assertSuccess(await execute('ui.render', {
    componentId,
    props: { title: 'Portable UI', count: 2 },
    fallback: { summary: 'Portable UI rendered', details: { count: 2 } },
  }), 'ui.render');
  const inlineRender = await call('runtime_render_component', {
    renderId: rendered.render?.id,
    context: { sessionId },
  });
  assert(
    inlineRender.render?.id === rendered.render?.id && inlineRender.props?.count === 2,
    'Stable compiled React display did not reuse the prepared render binding.',
  );
  const repeatedInlineRender = await call('runtime_render_component', {
    renderId: rendered.render?.id,
    context: { sessionId },
  });
  assert(
    repeatedInlineRender.render?.id === rendered.render?.id,
    'Cached compiled React render could not be shown again by render ID.',
  );
  const resources = await client.listResources();
  assert(
    resources.resources.some((resource) => resource.uri === rendered.render?.resourceUri),
    'Compiled React MCP App resource was not listed.',
  );
  const resource = await client.readResource({ uri: rendered.render.resourceUri });
  assert(
    resource.contents.some((content) => 'text' in content && content.text.includes('Content-Security-Policy')),
    'Compiled React resource did not expose the hardened HTML shell.',
  );
  report.reactUi = 'passed';

  const effect = assertSuccess(await execute('runtime.effects.execute', {
    kind: 'acceptance.unsupported',
    input: { marker: nonce },
    idempotencyKey: `acceptance-effect-${nonce}`,
  }), 'runtime.effects.execute');
  assert(effect.status === 'unsupported', 'Missing native effect handler was not explicit.');
  report.nativeEffects = 'passed';

  const codeStatus = assertSuccess(await execute('code.index.status', {}), 'code.index.status');
  assert(typeof codeStatus.state === 'string', 'Code-index status did not return an index state.');
  report.codeIndex = codeStatus.state;
  if (initializeCodeIndex) {
    assert(
      codeStatus.state === 'uninitialized',
      `Code-index initialization acceptance requires an uninitialized workspace, found ${codeStatus.state}.`,
    );
    const initialized = assertSuccess(
      await execute('code.index.initialize', {}),
      'code.index.initialize',
    );
    assert(initialized.after?.initialized === true, 'Code-index initialization did not create an index.');
    const ready = assertSuccess(await execute('code.index.status', {}), 'code.index.status');
    assert(ready.initialized === true, 'Code-index status did not observe the initialized index.');
    const symbolContext = assertSuccess(
      await execute('code.context', {
        name: 'RuntimePrincipal',
        file: 'src/contracts.ts',
        limit: 3,
      }),
      'code.context',
    );
    assert(
      typeof symbolContext.text === 'string' && symbolContext.text.includes('RuntimePrincipal'),
      'Code-index initialized but did not return real symbol context.',
    );
    report.codeIndex = `initialized:${ready.state}:context-ok`;
  }

  report.codexDelegation = 'registered';

  await call('runtime_observe_turn', {
    protocolVersion: '1.0.0',
    eventId: `${nonce}:observe`,
    sessionId,
    kind: 'assistant_turn',
    content: 'Acceptance completed.',
  });
  await call('runtime_session_end', {
    protocolVersion: '1.0.0',
    eventId: `${nonce}:end`,
    sessionId,
    outcome: 'complete',
  });
  report.lifecycle = 'passed';
  process.stdout.write(`${JSON.stringify({ ok: true, workspacePath, report }, null, 2)}\n`);
} finally {
  await client.close().catch(() => undefined);
  for (const target of cleanup) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  if (result.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent)}`);
  }
  return result.structuredContent ?? {};
}

function execute(target, input) {
  return call('runtime_exec', {
    protocolVersion: '1.0.0',
    targetType: 'operation',
    target,
    input,
    context: { sessionId },
  });
}

function assertSuccess(response, operation) {
  assert(
    response.status === 'success',
    `${operation} ended with ${String(response.status)}: ${JSON.stringify(response.error ?? response)}.`,
  );
  return response.result?.output ?? {};
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
