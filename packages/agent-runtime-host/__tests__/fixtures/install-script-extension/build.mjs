import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const entrypoint = String.raw`
const marker = 'live-install-fixture-marker-829';
const capability = Object.freeze({
  protocolVersion: '1.0.0',
  name: 'fixture.live.echo',
  version: '1.0.0',
  title: 'Fixture live echo',
  description: 'Echo through the live extension namespace.',
  tags: Object.freeze(['fixture', 'live', 'extension']),
  inputSchema: Object.freeze({
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  }),
  outputSchema: Object.freeze({
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
    additionalProperties: false,
  }),
});
const skill = Object.freeze({
  id: 'skill://fixture/live-install',
  kind: 'skill',
  title: 'Fixture live extension skill',
  description: 'Discover the live install fixture skill and its catalog entry.',
  tags: Object.freeze(['fixture', 'skill', 'extension']),
  action: Object.freeze({
    type: 'resource_read',
    uri: 'skill://fixture/live-install',
  }),
});

module.exports = {
  activate(context) {
    const prefix = context.configuration.prefix;
    return {
      capabilityProviders: [{
        id: '@fixture/live-install:capabilities',
        version: '1.0.0',
        list() { return [capability]; },
        get(name) { return name === capability.name ? capability : undefined; },
        invoke(name, input) {
          if (name !== capability.name) throw new Error('Unknown fixture capability.');
          return { output: { message: prefix + ':' + input.value } };
        },
      }],
      catalogProviders: [{
        id: '@fixture/live-install:catalog',
        list() { return [skill]; },
        get(id) { return id === skill.id ? skill : undefined; },
      }],
      resourceProviders: [{
        listResources() {
          return [{
            uri: 'skill://fixture/live-install',
            name: 'Fixture live extension skill',
            description: 'Live extension resource in the fixture namespace.',
            mimeType: 'text/markdown',
          }];
        },
        readResource(uri) {
          if (uri !== 'skill://fixture/live-install') {
            throw new Error('Unknown fixture resource.');
          }
          return {
            uri,
            mimeType: 'text/markdown',
            text: '# Fixture live extension\n\n' + marker,
          };
        },
      }],
    };
  },
};
`;

await mkdir(path.join(process.cwd(), 'dist'), { recursive: true });
await writeFile(path.join(process.cwd(), 'dist', 'index.cjs'), entrypoint, 'utf8');
process.stdout.write('fixture entrypoint built');
