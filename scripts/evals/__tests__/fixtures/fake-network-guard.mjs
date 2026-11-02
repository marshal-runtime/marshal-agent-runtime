#!/usr/bin/env node
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
process.stdout.write(`${JSON.stringify({
  ok: true,
  mode: 'recorded-test-fixture',
  fixtureSha256: request.fixtureSha256,
  guard: 'fake-network-guard',
})}\n`);
