#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchCdpBrowser } from './cdp.mjs';
import { STANDARDS_HOST_APPLICATION, STANDARDS_HOST_FALLBACK } from './host.mjs';

const exampleRoot = dirname(fileURLToPath(import.meta.url));
const hostScript = join(exampleRoot, 'host.mjs');

export async function runStandardsHostEvidence(options) {
  const outputRoot = requiredAbsolute(options?.output, 'output');
  const deployment = requiredAbsolute(options?.deployment, 'deployment');
  await mkdir(outputRoot, { recursive: true });
  if ((await readdir(outputRoot)).length > 0) throw new Error('output must be an empty directory; evidence is append-only and never overwritten.');
  const screenshotsRoot = join(outputRoot, 'screenshots');
  const stateRoot = join(outputRoot, 'host-state');
  await Promise.all([mkdir(screenshotsRoot), mkdir(stateRoot)]);
  const startedAt = new Date().toISOString();
  const attemptId = options.attemptId ?? `standards-host-${Date.now()}`;
  const driverTrace = [];
  const gates = [];
  let host;
  let browser;

  const trace = (type, payload = {}) => {
    const item = { sequence: driverTrace.length + 1, at: new Date().toISOString(), type, payload };
    driverTrace.push(item);
    return item;
  };
  const activate = async (selector, predicate) => {
    const clicked = await browser.page.click(selector, predicate);
    trace('browser-click', clicked);
    return clicked;
  };
  const screenshot = async (name) => {
    const path = join(screenshotsRoot, name);
    await browser.page.screenshot(path);
    const file = await describeFile(path, outputRoot);
    trace('browser-screenshot', file);
    return file;
  };

  try {
    host = await startHost({ stateRoot, deployment });
    trace('host-started', host.ready);
    if (host.ready.startup !== 'provisioned') throw new Error('Fresh evidence output unexpectedly reused an existing render.');
    const requestBoundary = await auditRequestBoundary(host.ready.url);
    trace('request-boundary-audited', requestBoundary);
    gates.push(gate('local-request-boundary', 'observed', {
      notes: ['Mutation endpoints require the active same origin, exact JSON media type, and an unguessable per-host capability token.'],
    }));
    browser = await launchCdpBrowser({ executable: options.browser });
    trace('browser-started', { executable: browser.executable, processId: browser.processId });
    await browser.page.setViewport(320, 900);
    await browser.page.navigate(host.ready.url);
    await browser.page.find('#tool-status', (value) => value.text.includes('loaded revision 0'));
    const narrowChrome = await browser.page.find('#chrome', (value) =>
      value.hidden === false
      && value.width > 0
      && value.height >= 40
      && value.documentScrollWidth <= value.clientWidth,
    );
    const narrowFullscreen = await browser.page.find('button[data-chrome-key="fullscreen"]', (value) =>
      value.display !== 'none'
      && value.width >= 40
      && value.height >= 40
      && value.left >= 0
      && value.right <= value.clientWidth,
    );
    const narrowPip = await browser.page.find('button[data-chrome-key="pip"]', (value) =>
      value.display !== 'none'
      && value.width >= 40
      && value.height >= 40
      && value.left >= 0
      && value.right <= value.clientWidth,
    );
    const narrowSave = await browser.page.find('button[data-chrome-key="save-selection"]', (value) =>
      value.display !== 'none'
      && value.disabled === false
      && value.width >= 40
      && value.height >= 40
      && value.left >= 0
      && value.right <= value.clientWidth,
    );
    const narrowReopen = await browser.page.find('button[data-chrome-key="reopen-selection"]', (value) =>
      value.display !== 'none'
      && value.disabled === false
      && value.width >= 40
      && value.height >= 40
      && value.left >= 0
      && value.right <= value.clientWidth,
    );
    const narrowChild = await browser.page.find('#mount iframe', (value) => value.height >= 240);
    const expectedTotalHeight = Math.ceil(narrowChrome.value.height + narrowChild.value.height);
    await browser.page.find(`#frame-shell[data-reported-height="${expectedTotalHeight}"]`);
    const reportedHeight = expectedTotalHeight;
    const focusRetention = await browser.page.evaluateWhere(
      'button[data-chrome-key="fullscreen"]',
      `(()=>{const before=document.querySelector('button[data-chrome-key="fullscreen"]');window.focus();before.focus({preventScroll:true});const focusedBefore=document.activeElement===before;window.dispatchEvent(new MessageEvent('message',{source:parent,data:{jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{displayMode:'inline',availableDisplayModes:['inline','fullscreen'],containerDimensions:{width:320,height:900}}}}));return{same:document.querySelector('button[data-chrome-key="fullscreen"]')===before,focusedBefore,focused:document.activeElement===before};})()`,
    );
    if (focusRetention?.same !== true || focusRetention?.focusedBefore !== true || focusRetention?.focused !== true) {
      throw new Error(`Renderer chrome did not preserve focus across reconciliation: ${JSON.stringify(focusRetention)}`);
    }
    gates.push(gate('adaptive-outer-chrome-320px', 'observed', {
      notes: [
        `chrome=${Math.round(narrowChrome.value.width)}x${Math.round(narrowChrome.value.height)}`,
        `fullscreen=${Math.round(narrowFullscreen.value.width)}x${Math.round(narrowFullscreen.value.height)}`,
        `pip=${Math.round(narrowPip.value.width)}x${Math.round(narrowPip.value.height)}`,
        `save=${Math.round(narrowSave.value.width)}x${Math.round(narrowSave.value.height)}`,
        `reopen=${Math.round(narrowReopen.value.width)}x${Math.round(narrowReopen.value.height)}`,
        `document=${narrowChrome.value.documentScrollWidth}/${narrowChrome.value.clientWidth}px; totalHeight=${reportedHeight}px; focusPreserved=${focusRetention.focused}`,
      ],
    }));
    await browser.page.setViewport(1280, 900);
    await browser.page.navigate(host.ready.url);

    await browser.page.find('#selection-value', (value) => value.text.includes('Direction A'));
    await browser.page.find('#tool-status', (value) => value.text.includes('loaded revision 0'));
    const inlineShot = await screenshot('01-inline.png');
    gates.push(gate('inline-pixels', 'observed', { screenshot: inlineShot.path }));

    await activate('button[data-chrome-key="save-selection"]', (value) => value.disabled === false);
    await browser.page.find('#action-status', (value) => value.text.includes('saved revision 1'));
    await browser.page.find('#chrome-status', (value) => value.text.includes('success: Save selected direction completed'));
    const saveReceiptView = await browser.page.find('#action-receipt', (value) => value.text !== 'none');
    const saveReceiptId = saveReceiptView.value.text.trim();
    await activate('#action-draft');
    await browser.page.find('#selection-value', (value) => value.text.includes('Direction C draft'));
    await activate('button[data-chrome-key="reopen-selection"]', (value) => value.disabled === false);
    await browser.page.find('#action-status', (value) => value.text.includes('reopened revision 1'));
    await browser.page.find('#selection-value', (value) => value.text.includes('Direction B'));
    await browser.page.find('#chrome-status', (value) => value.text.includes('success: Reopen saved selection completed'));
    const reopenReceiptView = await browser.page.find('#action-receipt', (value) =>
      value.text !== 'none' && value.text.trim() !== saveReceiptId,
    );
    const actionShot = await screenshot('02-action.png');
    const reopenReceiptId = reopenReceiptView.value.text.trim();
    gates.push(gate('capability-action', 'observed', {
      screenshot: actionShot.path,
      receiptIds: [saveReceiptId, reopenReceiptId],
      notes: [
        'Clicked both manifest-derived outer Save and Reopen controls.',
        'Save wrote Direction B; a local Direction C draft was then replaced by Reopen through two typed dispatcher receipts.',
      ],
    }));

    await activate('#host-theme');
    await browser.page.find('#theme-value', (value) => value.text.includes('dark'));
    await activate('#host-resize');
    await browser.page.find('#dimensions-value', (value) => value.text.includes('390×560'));
    await browser.page.find('#safe-area-value', (value) => value.text.includes('12/8/20/8'));
    const contextShot = await screenshot('03-theme-resize-safe-area.png');
    gates.push(gate('theme-resize-safe-area', 'observed', { screenshot: contextShot.path }));

    await activate('#mode-fullscreen');
    await browser.page.find('#mode-status', (value) => value.text.includes('fullscreen:granted:fullscreen'));
    const fullscreenShot = await screenshot('04-fullscreen.png');
    gates.push(gate('fullscreen', 'granted', { screenshot: fullscreenShot.path }));

    await activate('#mode-pip');
    await browser.page.find('#mode-status', (value) => value.text.includes('pip:unsupported:fullscreen'));
    const pipShot = await screenshot('05-pip-unsupported.png');
    gates.push(gate('pip', 'unsupported', {
      screenshot: pipShot.path,
      notes: ['The app declared PiP; the named host advertised only inline/fullscreen and the app kept fullscreen usable.'],
    }));

    await activate('#host-remount');
    await browser.page.find('#selection-value', (value) => value.text.includes('Direction B'));
    await browser.page.find('#tool-status', (value) => value.text.includes('loaded revision 1'));
    const remountStatus = await fetchJson(new URL('/status', host.ready.url));
    if (remountStatus.renderId !== host.ready.renderId) throw new Error('Remount changed the render ID.');
    if (remountStatus.counters.compileInvocations !== 1 || remountStatus.counters.renderInvocations !== 1) {
      throw new Error(`Remount unexpectedly compiled or rebound: ${JSON.stringify(remountStatus.counters)}`);
    }
    const remountShot = await screenshot('06-remount.png');
    gates.push(gate('remount', 'observed', {
      screenshot: remountShot.path,
      notes: ['Same render ID, one original compile, one original binding, authoritative state restored by declared tool.'],
    }));

    const hydrationStarted = Date.now();
    await activate('#host-hydration');
    const hydration = await browser.page.find('#status', (value) => value.className.includes('error') && value.text.includes(STANDARDS_HOST_FALLBACK.summary), 6_000);
    const hydrationMs = Date.now() - hydrationStarted;
    if (hydrationMs >= 5_000) throw new Error(`Hydration fallback exceeded five seconds: ${hydrationMs} ms.`);
    const fallbackShot = await screenshot('07-hydration-fallback.png');
    gates.push(gate('hydration-fallback', 'fallback', {
      screenshot: fallbackShot.path,
      timingMs: hydrationMs,
      notes: [hydration.value.text],
    }));
    gates.push(gate('complete-fallback', 'observed', {
      screenshot: fallbackShot.path,
      notes: [STANDARDS_HOST_FALLBACK.summary],
    }));

    const beforeRestart = await fetchJson(new URL('/status', host.ready.url));
    await stopHost(host);
    trace('host-process-stopped', { renderId: beforeRestart.renderId });
    host = await startHost({ stateRoot, deployment });
    trace('host-restarted', host.ready);
    if (host.ready.startup !== 'reopened') throw new Error(`Restart did not reopen durable state: ${host.ready.startup}.`);
    if (host.ready.renderId !== beforeRestart.renderId) throw new Error('Restart changed the render ID.');
    await browser.page.navigate(host.ready.url);
    await browser.page.find('#selection-value', (value) => value.text.includes('Direction B'));
    await browser.page.find('#tool-status', (value) => value.text.includes('loaded revision 1'));
    const afterRestart = await fetchJson(new URL('/status', host.ready.url));
    if (afterRestart.counters.compileInvocations !== 0 || afterRestart.counters.renderInvocations !== 0) {
      throw new Error(`Restart recompiled or rebound the render: ${JSON.stringify(afterRestart.counters)}`);
    }
    const restartShot = await screenshot('08-host-restart.png');
    gates.push(gate('host-restart', 'observed', {
      screenshot: restartShot.path,
      notes: ['A new host process reopened the same render ID and Direction B with zero compile/render calls.'],
    }));

    const hostTracePath = afterRestart.paths.eventsPath;
    const hostReceiptsPath = afterRestart.paths.receiptsPath;
    await Promise.all([
      copyFile(hostTracePath, join(outputRoot, 'host-trace.jsonl')),
      copyFile(hostReceiptsPath, join(outputRoot, 'receipts.jsonl')),
      writeJson(join(outputRoot, 'application.json'), STANDARDS_HOST_APPLICATION),
      writeJson(join(outputRoot, 'fallback.json'), STANDARDS_HOST_FALLBACK),
    ]);
    for (const item of driverTrace) {
      await appendJsonLine(join(outputRoot, 'driver-trace.jsonl'), item);
    }
    const sourceManifest = {
      schemaVersion: '1.0.0',
      files: await Promise.all([
        describeFile(join(exampleRoot, 'StandardsHostApp.tsx'), exampleRoot),
        describeFile(join(exampleRoot, 'standards-host.css'), exampleRoot),
        describeFile(join(deployment, 'dist', 'index.js'), deployment),
      ]),
    };
    await writeJson(join(outputRoot, 'source-manifest.json'), sourceManifest);

    const completedAt = new Date().toISOString();
    const report = {
      schemaVersion: '1.0.0',
      evidenceClass: 'automated-local-live-standards-host',
      publicationClaimEligible: false,
      attemptId,
      startedAt,
      completedAt,
      host: afterRestart.host,
      browser: { executable: browser.executable, interactionDriver: 'chrome-devtools-protocol', activation: 'dom-click' },
      runtimePackage: afterRestart.runtimePackage,
      render: {
        renderId: afterRestart.renderId,
        componentId: afterRestart.componentId,
        sourceDigest: afterRestart.sourceDigest,
        beforeRestartCounters: beforeRestart.counters,
        afterRestartCounters: afterRestart.counters,
      },
      state: afterRestart.authoritative,
      gates,
      files: await listEvidenceFiles(outputRoot),
      limitations: [
        'Browser activations use deterministic DOM click dispatch and are disclosed as automation, not human pointer input.',
        'Screenshots are live browser pixels but are not an uncut video and have not received independent human review.',
        'PiP is truthfully unsupported by this host; no PiP-granted compatibility claim is made.',
        'The host uses local HTTP and an installed package root; remote authentication and public-network transport are out of scope.',
        'Local mutation endpoints are origin-, media-type-, and per-host-capability-bound; this is a local demonstration host, not a remote multi-user service.',
      ],
    };
    await writeJson(join(outputRoot, 'report.json'), report);
    report.files = await listEvidenceFiles(outputRoot);
    await writeJson(join(outputRoot, 'report.json'), report);
    return report;
  } finally {
    await browser?.page.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (host) await stopHost(host).catch(() => undefined);
  }
}

async function startHost({ stateRoot, deployment }) {
  const child = spawn(process.execPath, [
    hostScript,
    '--state-root', stateRoot,
    '--deployment', deployment,
  ], { cwd: exampleRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  const ready = await new Promise((resolveReady, rejectReady) => {
    let stdout = '';
    const timer = setTimeout(() => {
      rejectReady(new Error(`Timed out starting standards host. stderr=${stderr}`));
    }, 30_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('STANDARDS_HOST_READY ')) continue;
        clearTimeout(timer);
        resolveReady(JSON.parse(line.slice('STANDARDS_HOST_READY '.length)));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`Standards host exited before ready with code ${code}. stderr=${stderr}`));
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectReady(error);
    });
  });
  return { child, ready, stderr: () => stderr };
}

async function stopHost(host) {
  if (host.child.exitCode !== null) return;
  host.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => host.child.once('exit', resolveExit)),
    delay(5_000).then(() => {
      host.child.kill();
      throw new Error(`Standards host did not stop cleanly. stderr=${host.stderr()}`);
    }),
  ]);
}

function gate(id, status, options = {}) {
  return {
    id,
    status,
    observedAt: new Date().toISOString(),
    screenshot: options.screenshot,
    timingMs: options.timingMs,
    receiptIds: options.receiptIds ?? [],
    notes: options.notes ?? [],
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function auditRequestBoundary(rootUrl) {
  const origin = new URL(rootUrl).origin;
  const pageResponse = await fetch(rootUrl);
  const page = await pageResponse.text();
  if (!pageResponse.ok) throw new Error(`Could not load standards-host page for request-boundary audit: ${pageResponse.status}.`);
  const tokenMatch = page.match(/const capabilityToken=("[A-Za-z0-9_-]{43}");/);
  if (!tokenMatch) throw new Error('Standards-host page did not contain one ephemeral capability token.');
  const capabilityToken = JSON.parse(tokenMatch[1]);
  const before = await fetchJson(new URL('/status', rootUrl));
  const attempts = [
    await mutation('/tool', { origin, contentType: 'application/json' }),
    await mutation('/event', { origin, contentType: 'application/json', capabilityToken: 'wrong-token' }),
    await mutation('/event', { origin: 'http://attacker.invalid', contentType: 'application/json', capabilityToken }),
    await mutation('/event', { origin, contentType: 'text/plain', capabilityToken }),
    await mutation('/event', { contentType: 'application/json', capabilityToken }),
  ];
  assertStatuses(attempts, [403, 403, 403, 415, 403]);
  const preflight = await fetch(new URL('/tool', rootUrl), {
    method: 'OPTIONS',
    headers: { origin: 'http://attacker.invalid', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-marshal-host-capability' },
  });
  if (preflight.ok || preflight.headers.has('access-control-allow-origin')) {
    throw new Error('Cross-origin preflight unexpectedly authorized a mutation endpoint.');
  }
  const afterDenied = await fetchJson(new URL('/status', rootUrl));
  if (afterDenied.eventCount !== before.eventCount
    || JSON.stringify(afterDenied.counters) !== JSON.stringify(before.counters)) {
    throw new Error('Denied local mutation attempts changed host state, receipts, counters, or trace evidence.');
  }
  const accepted = await mutation('/event', {
    origin,
    contentType: 'application/json',
    capabilityToken,
    body: { type: 'request-boundary-audit', payload: { deniedAttempts: attempts.length } },
  });
  if (accepted.status !== 200) throw new Error(`Valid same-origin capability-bound event was rejected with ${accepted.status}.`);
  return {
    deniedStatuses: attempts.map((item) => item.status),
    preflightStatus: preflight.status,
    acceptedStatus: accepted.status,
    deniedMutationCount: attempts.length,
    tokenBytes: Buffer.from(capabilityToken, 'base64url').length,
  };

  async function mutation(path, options) {
    const headers = {};
    if (options.origin) headers.origin = options.origin;
    if (options.contentType) headers['content-type'] = options.contentType;
    if (options.capabilityToken) headers['x-marshal-host-capability'] = options.capabilityToken;
    const response = await fetch(new URL(path, rootUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body ?? { type: 'forged-event', payload: {} }),
    });
    return { status: response.status };
  }
}

function assertStatuses(actual, expected) {
  const statuses = actual.map((item) => item.status);
  if (JSON.stringify(statuses) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected request-boundary statuses: ${JSON.stringify(statuses)}.`);
  }
}

async function describeFile(path, root) {
  const bytes = await readFile(path);
  return {
    path: path.slice(root.length + 1).replaceAll('\\', '/'),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function listEvidenceFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name !== 'report.json' && !path.includes(`${join(root, 'host-state')}\\`) && !path.includes(`${join(root, 'host-state')}/`)) {
        files.push(await describeFile(path, root));
      }
    }
  }
  await walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function appendJsonLine(path, value) {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function requiredAbsolute(value, field) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${field} must be an absolute path.`);
  return resolve(value);
}

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument ${argument}.`);
    const key = argument.slice(2);
    const value = values[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

if (import.meta.url === pathToFileURL(process.argv[1] ? resolve(process.argv[1]) : '').href) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const report = await runStandardsHostEvidence({
      output: args.output,
      deployment: args.deployment,
      ...(args.browser ? { browser: requiredAbsolute(args.browser, 'browser') } : {}),
      ...(args['attempt-id'] ? { attemptId: args['attempt-id'] } : {}),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
