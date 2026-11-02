import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  STANDARDS_HOST_APPLICATION,
  STANDARDS_HOST_FALLBACK,
  createStandardsMcpAppsHost,
} from '../../standards-mcp-apps-host/host.mjs';

test('standards host authored source uses only declared injected-client operations', async () => {
  const source = await readFile(resolve('examples/standards-mcp-apps-host/StandardsHostApp.tsx'), 'utf8');
  assert.match(source, /MarshalUiComponentProps/);
  assert.match(source, /UiDisplayMode/);
  assert.match(source, /marshal\.host\.context\.availableDisplayModes\.includes\(mode\)/);
  assert.match(source, /marshal\.callAction[^]*'save-selection'/);
  assert.match(source, /marshal\.callAction[^]*'reopen-selection'/);
  assert.match(source, /marshal\.bindActionControl[^]*'save-selection'/);
  assert.match(source, /marshal\.bindActionControl[^]*'reopen-selection'/);
  assert.match(source, /\(\{ signal \}\) => saveSelection\(signal\)/);
  assert.match(source, /\(\{ signal \}\) => reopenSelection\(signal\)/);
  assert.match(source, /idempotencyKey: 'standards-host-save-direction-b-v1'/);
  assert.match(source, /marshal\.callTool[^]*'read-selection'/);
  assert.doesNotMatch(source, /postMessage|window\.openai|workflow/i);
  assert.deepEqual(STANDARDS_HOST_APPLICATION.presentationModes, ['inline', 'fullscreen', 'pip']);
  assert.deepEqual(STANDARDS_HOST_APPLICATION.actions.map((item) => item.id), [
    'save-selection',
    'reopen-selection',
  ]);
  assert.deepEqual(STANDARDS_HOST_APPLICATION.tools.map((item) => item.id), ['read-selection']);
  assert.ok(STANDARDS_HOST_FALLBACK.summary.length >= 40);
});

test('standards host reopens an immutable render without fixture substitution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'marshal-standards-host-test-'));
  const deployment = resolve('packages/agent-runtime-ui');
  let first;
  let second;
  try {
    first = await createStandardsMcpAppsHost({ stateRoot: root, deployment });
    const before = await first.snapshot();
    assert.equal(first.startup, 'provisioned');
    assert.deepEqual(before.counters, {
      compileInvocations: 1,
      renderInvocations: 1,
      actionInvocations: 0,
      toolInvocations: 0,
    });
    const renderId = first.renderId;
    await first.close();
    first = undefined;

    second = await createStandardsMcpAppsHost({ stateRoot: root, deployment });
    const after = await second.snapshot();
    assert.equal(second.startup, 'reopened');
    assert.equal(second.renderId, renderId);
    assert.equal(after.counters.compileInvocations, 0);
    assert.equal(after.counters.renderInvocations, 0);
  } finally {
    await first?.close();
    await second?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test('standards host mutation endpoints reject local CSRF without changing state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'marshal-standards-host-csrf-'));
  let host;
  try {
    host = await createStandardsMcpAppsHost({ stateRoot: root, deployment: resolve('packages/agent-runtime-ui') });
    const origin = new URL(host.url).origin;
    const page = await (await fetch(host.url)).text();
    const tokenMatch = page.match(/const capabilityToken=("[A-Za-z0-9_-]{43}");/);
    assert.ok(tokenMatch, 'served page must contain one 256-bit ephemeral capability token');
    const token = JSON.parse(tokenMatch[1]);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.doesNotMatch(JSON.stringify(await host.snapshot()), new RegExp(token));
    assert.doesNotMatch(JSON.stringify({ url: host.url, renderId: host.renderId }), new RegExp(token));

    const before = await host.snapshot();
    const denied = await Promise.all([
      post('/tool', { origin, contentType: 'application/json' }),
      post('/event', { origin, contentType: 'application/json', token: 'wrong' }),
      post('/event', { origin: 'http://attacker.invalid', contentType: 'application/json', token }),
      post('/event', { origin, contentType: 'text/plain', token }),
      post('/event', { origin, contentType: 'application/json; charset=utf-8', token }),
      post('/event', { contentType: 'application/json', token }),
      post('/event', { origin, contentType: 'application/json', token, fetchSite: 'cross-site' }),
    ]);
    assert.deepEqual(denied.map((response) => response.status), [403, 403, 403, 415, 415, 403, 403]);
    const afterDenied = await host.snapshot();
    assert.equal(afterDenied.eventCount, before.eventCount);
    assert.equal(afterDenied.receiptCount, before.receiptCount);
    assert.deepEqual(afterDenied.counters, before.counters);

    const accepted = await post('/tool', {
      origin,
      contentType: 'application/json',
      token,
      body: {
        name: 'marshal_invoke_react_tool',
        arguments: {
          renderId: host.renderId,
          toolId: 'read-selection',
          input: { resourceId: 'standards-host-selection' },
        },
      },
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).structuredContent.status, 'success');

    async function post(path, options) {
      const headers = {};
      if (options.origin) headers.origin = options.origin;
      if (options.contentType) headers['content-type'] = options.contentType;
      if (options.token) headers['x-marshal-host-capability'] = options.token;
      if (options.fetchSite) headers['sec-fetch-site'] = options.fetchSite;
      return fetch(new URL(path, host.url), {
        method: 'POST',
        headers,
        body: JSON.stringify(options.body ?? { type: 'forged-event', payload: {} }),
      });
    }
  } finally {
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
