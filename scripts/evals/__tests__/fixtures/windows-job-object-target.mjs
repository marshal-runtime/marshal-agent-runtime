#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runWindowsConfinementCapabilityProbe } from '../../security/windows-confinement-capability-probe.mjs';

const [mode, ...args] = process.argv.slice(2);

if (mode === 'report-tree') {
  const child = spawn(process.execPath, [resolve(process.argv[1]), 'report-leaf'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
    shell: false,
  });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  const childExit = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolveExit(code));
  });
  const probe = runWindowsConfinementCapabilityProbe();
  process.stdout.write(`${JSON.stringify({
    ok: childExit === 0,
    targetPid: process.pid,
    targetProbeProcessInJob: probe.hostFacts.token.currentProcessIsInJob,
    descendant: JSON.parse(Buffer.concat(chunks).toString('utf8')),
  })}\n`);
} else if (mode === 'report-leaf') {
  const probe = runWindowsConfinementCapabilityProbe();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    descendantPid: process.pid,
    descendantProbeProcessInJob: probe.hostFacts.token.currentProcessIsInJob,
  })}\n`);
} else if (mode === 'linger-tree') {
  const [markerFile, delayText] = args;
  const leaf = spawn(process.execPath, [resolve(process.argv[1]), 'delayed-marker', markerFile, delayText], {
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  });
  leaf.unref();
  process.stdout.write(`${JSON.stringify({ ready: true, targetPid: process.pid, descendantPid: leaf.pid })}\n`);
  setInterval(() => {}, 60_000);
} else if (mode === 'delayed-marker') {
  const [markerFile, delayText] = args;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, Number(delayText)));
  await writeFile(markerFile, `escaped:${process.pid}\n`, { flag: 'wx' });
} else if (mode === 'exit') {
  process.stdout.write(`${JSON.stringify({ ok: true, exitCode: Number(args[0]) })}\n`);
  process.exitCode = Number(args[0]);
} else {
  throw new Error(`Unknown Windows Job Object target mode: ${String(mode)}`);
}
