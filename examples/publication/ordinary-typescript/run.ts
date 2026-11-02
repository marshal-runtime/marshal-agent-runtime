import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeTypeScriptModule, type JsonValue } from '@marshal/agent-runtime-typescript';

const root = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(root, 'analyze-orders.ts'), 'utf8');
const input = JSON.parse(await readFile(join(root, 'orders.json'), 'utf8')) as unknown;

const result = await executeTypeScriptModule({
  source,
  input: input as JsonValue,
  filename: 'examples/publication/ordinary-typescript/analyze-orders.ts',
  timeoutMs: 1_000,
  maxOutputBytes: 65_536,
});

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
