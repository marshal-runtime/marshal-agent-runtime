#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] === '--attest') {
  const profile = readFileSync(args[1]);
  const parsedProfile = JSON.parse(profile.toString('utf8'));
  const request = JSON.parse(await readStdin());
  process.stdout.write(`${JSON.stringify({
    ok: true,
    challenge: request.challenge,
    mechanism: parsedProfile.mechanism,
    enforcementMode: parsedProfile.enforcementMode,
    profileSha256: createHash('sha256').update(profile).digest('hex'),
    profileSemanticsSha256: request.profileSemanticsSha256,
    coversDescendants: true,
    coverage: request.requiredCoverage,
    testOnly: false,
    measurement: createHash('sha256').update(`fixture-measurement:${request.challenge}`).digest('hex'),
  })}\n`);
} else if (args[0] === '--run') {
  const command = args[2];
  const child = spawn(command, args.slice(3), { stdio: 'inherit', windowsHide: true, shell: false });
  child.once('error', (error) => { throw error; });
  child.once('close', (code) => { process.exitCode = code ?? 1; });
} else {
  throw new Error('Expected --attest <profile> or --run <profile> <command> [...args].');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
