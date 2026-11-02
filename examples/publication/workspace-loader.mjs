import { access } from 'node:fs/promises';

const packagePattern = /^@marshal\/([a-z0-9-]+)$/;

export async function resolve(specifier, context, nextResolve) {
  const match = packagePattern.exec(specifier);
  if (!match) return nextResolve(specifier, context);
  const url = new URL(`../../packages/${match[1]}/dist/index.js`, import.meta.url);
  try {
    await access(url);
  } catch {
    throw new Error(`Build ${specifier} before running publication examples; missing ${url.pathname}`);
  }
  return { url: url.href, shortCircuit: true };
}
