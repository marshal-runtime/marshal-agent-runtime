import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityInvocationResult,
  type CapabilityProvider,
  type InvocationContext,
} from '@marshal/agent-runtime-core';
import type { RuntimeServiceAccessor } from '@marshal/agent-runtime-composer';
import type { RuntimeAuthoredUiStateService, UiApplicationCreationRequest, UiApplicationUpdateRequest } from './contracts.js';
import { RUNTIME_AUTHORED_UI_STATE_SERVICE } from './contracts.js';
import { assertUiSchema } from '../schemaValidation.js';

const OPERATIONS = [
  'ui.authored.create',
  'ui.authored.read',
  'ui.authored.list',
  'ui.authored.update',
  'ui.authored.changeState',
  'ui.authored.readSnapshot',
  'ui.authored.remove',
  'ui.authored.migrate',
] as const;
type Operation = (typeof OPERATIONS)[number];
const READ_PERMISSIONS = [{ permission: 'ui.authored.read', risk: 'low' as const }];
const WRITE_PERMISSIONS = [{ permission: 'ui.authored.write', risk: 'high' as const }];
const ID_SCHEMA = { type: 'string', minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9_.:-]+$' };
const DIGEST_SCHEMA = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const APPLICATION_SCHEMA = { type: 'object', additionalProperties: true };
const PROVENANCE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['kind', 'sourceDigest', 'componentId', 'renderId', 'componentDigest', 'renderDigest'],
  properties: {
    kind: { type: 'string', enum: ['workspace_file', 'registered_component', 'authored_typescript', 'snapshot'] },
    path: { type: 'string', minLength: 1, maxLength: 256 },
    sourceDigest: DIGEST_SCHEMA, componentId: DIGEST_SCHEMA, renderId: DIGEST_SCHEMA,
    componentDigest: DIGEST_SCHEMA, renderDigest: DIGEST_SCHEMA,
  },
};
const CREATION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['application', 'provenance'],
  properties: {
    identity: { type: 'object', additionalProperties: false, properties: { id: ID_SCHEMA } },
    title: { type: 'string', minLength: 1, maxLength: 256 },
    description: { type: 'string', minLength: 1, maxLength: 256 },
    tags: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 256 } },
    metadata: { type: 'object' }, application: APPLICATION_SCHEMA, props: { type: 'object' },
    provenance: PROVENANCE_SCHEMA, initialState: { type: 'object' },
  },
};
const UPDATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['expectedVersion'],
  properties: {
    expectedVersion: { type: 'integer', minimum: 0 },
    title: { oneOf: [{ type: 'string', maxLength: 256 }, { type: 'null' }] },
    description: { oneOf: [{ type: 'string', maxLength: 256 }, { type: 'null' }] },
    tags: { oneOf: [{ type: 'array', maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 256 } }, { type: 'null' }] },
    metadata: { oneOf: [{ type: 'object' }, { type: 'null' }] },
    application: APPLICATION_SCHEMA, props: { type: 'object' }, provenance: PROVENANCE_SCHEMA,
  },
};
const INPUT_SCHEMAS: Record<Operation, Record<string, unknown>> = {
  'ui.authored.create': CREATION_SCHEMA,
  'ui.authored.migrate': CREATION_SCHEMA,
  'ui.authored.read': { type: 'object', additionalProperties: false, required: ['id'], properties: { id: ID_SCHEMA } },
  'ui.authored.list': { type: 'object', additionalProperties: false },
  'ui.authored.update': { type: 'object', additionalProperties: false, required: ['id', 'request'], properties: { id: ID_SCHEMA, request: UPDATE_SCHEMA } },
  'ui.authored.changeState': { type: 'object', additionalProperties: false, required: ['id', 'state', 'expectedVersion'], properties: { id: ID_SCHEMA, state: { type: 'object' }, expectedVersion: { type: 'integer', minimum: 0 } } },
  'ui.authored.readSnapshot': { type: 'object', additionalProperties: false, required: ['id', 'snapshotDigest'], properties: { id: ID_SCHEMA, snapshotDigest: DIGEST_SCHEMA } },
  'ui.authored.remove': { type: 'object', additionalProperties: false, required: ['id', 'expectedVersion'], properties: { id: ID_SCHEMA, expectedVersion: { type: 'integer', minimum: 0 } } },
};
const OUTPUT_SCHEMAS: Record<Operation, Record<string, unknown>> = {
  'ui.authored.create': { type: 'object', additionalProperties: false, required: ['application'], properties: { application: { type: 'object' } } },
  'ui.authored.migrate': { type: 'object', additionalProperties: false, required: ['application'], properties: { application: { type: 'object' } } },
  'ui.authored.read': { type: 'object', additionalProperties: false, properties: { application: { type: 'object' } } },
  'ui.authored.list': { type: 'object', additionalProperties: false, required: ['applications'], properties: { applications: { type: 'array' } } },
  'ui.authored.update': { type: 'object', additionalProperties: false, required: ['application'], properties: { application: { type: 'object' } } },
  'ui.authored.changeState': { type: 'object', additionalProperties: false, required: ['application'], properties: { application: { type: 'object' } } },
  'ui.authored.readSnapshot': { type: 'object', additionalProperties: false, properties: { application: { type: 'object' } } },
  'ui.authored.remove': { type: 'object', additionalProperties: false, required: ['removed'], properties: { removed: { type: 'boolean' } } },
};

export class ReactUiAuthoredStateProvider implements CapabilityProvider {
  readonly id = 'portable.react-ui-authored-state';
  readonly version = '1.0.0';

  constructor(
    private readonly serviceOrAccessor: RuntimeAuthoredUiStateService | RuntimeServiceAccessor,
  ) {}

  private service(): RuntimeAuthoredUiStateService {
    return 'get' in this.serviceOrAccessor
      ? this.serviceOrAccessor.get(RUNTIME_AUTHORED_UI_STATE_SERVICE)
      : this.serviceOrAccessor;
  }

  list(_context: InvocationContext): readonly CapabilityDescriptor[] {
    return OPERATIONS.map((name) => ({
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      name,
      title: name,
      description: `Scoped authored React UI state operation: ${name}.`,
      inputSchema: INPUT_SCHEMAS[name as Operation],
      version: this.version,
      outputSchema: OUTPUT_SCHEMAS[name as Operation],
      permissions: name === 'ui.authored.read' || name === 'ui.authored.list' || name === 'ui.authored.readSnapshot'
        ? READ_PERMISSIONS : WRITE_PERMISSIONS,
    }));
  }

  get(name: string, _context: InvocationContext): CapabilityDescriptor | undefined {
    return OPERATIONS.includes(name as (typeof OPERATIONS)[number])
      ? this.list(undefined as never).find((descriptor) => descriptor.name === name)
      : undefined;
  }

  async invoke(name: string, input: unknown, context: InvocationContext): Promise<CapabilityInvocationResult> {
    if (!OPERATIONS.includes(name as (typeof OPERATIONS)[number])) throw new Error(`Unknown authored UI capability: ${name}`);
    const args = object(input);
    assertUiSchema(args, INPUT_SCHEMAS[name as Operation]);
    const service = this.service();
    switch (name) {
      case 'ui.authored.create': return { output: { application: await service.create(args as unknown as UiApplicationCreationRequest, context) } };
      case 'ui.authored.migrate': return { output: { application: await service.migrate(args as unknown as UiApplicationCreationRequest, context) } };
      case 'ui.authored.read': return { output: { application: await service.read(string(args.id, 'id'), context) } };
      case 'ui.authored.list': return { output: { applications: await service.list(context) } };
      case 'ui.authored.update': return { output: { application: await service.update(string(args.id, 'id'), args.request as UiApplicationUpdateRequest, context) } };
      case 'ui.authored.changeState': return { output: { application: await service.changeState(string(args.id, 'id'), object(args.state), number(args.expectedVersion), context) } };
      case 'ui.authored.readSnapshot': return { output: { application: await service.readSnapshot(string(args.id, 'id'), string(args.snapshotDigest, 'snapshotDigest'), context) } };
      case 'ui.authored.remove': return { output: { removed: await service.remove(string(args.id, 'id'), number(args.expectedVersion), context) } };
    }
    throw new Error(`Unsupported authored UI capability: ${name}`);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('input must be an object');
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}
function number(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error('expectedVersion must be a safe integer');
  return value as number;
}
