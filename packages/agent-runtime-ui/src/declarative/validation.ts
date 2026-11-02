import type { JsonObject } from './json.js';
import type { DeclarativeUiDocument, UiActionBinding, UiNode, UiScalar } from './types.js';
import { asObject, requireString } from './json.js';

export interface UiValidationLimits {
  maxDocumentBytes?: number;
  maxNodes?: number;
  maxDepth?: number;
  maxActions?: number;
  maxStringLength?: number;
  maxTableCells?: number;
}

const NODE_TYPES = new Set([
  'stack',
  'card',
  'heading',
  'text',
  'badge',
  'button',
  'input',
  'select',
  'progress',
  'divider',
  'table',
]);
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function validateUiDocument(
  value: unknown,
  limits: UiValidationLimits = {},
): DeclarativeUiDocument {
  const maxBytes = limits.maxDocumentBytes ?? 256 * 1024;
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).length > maxBytes)
    throw new Error(`UI document exceeds ${maxBytes} bytes`);
  const document = asObject(value, 'document');
  rejectUnknownKeys(
    document,
    ['protocolVersion', 'title', 'description', 'root', 'actions'],
    'document',
  );
  if (document.protocolVersion !== '1.0.0')
    throw new Error('document.protocolVersion must be 1.0.0');
  requireString(document.title, 'document.title', 256);
  if (document.description !== undefined)
    requireString(document.description, 'document.description', 2_000);
  const state = { nodes: 0, ids: new Set<string>(), tableCells: 0 };
  validateNode(document.root, 1, state, limits);
  const actions = document.actions === undefined ? [] : array(document.actions, 'document.actions');
  if (actions.length > (limits.maxActions ?? 100)) throw new Error('Too many UI actions');
  const actionIds = new Set<string>();
  for (const value of actions) {
    const action = asObject(value, 'action');
    rejectUnknownKeys(action, ['id', 'operation', 'input', 'eventMap', 'confirmation'], 'action');
    const id = safeId(action.id, 'action.id');
    if (actionIds.has(id)) throw new Error(`Duplicate action id ${id}`);
    actionIds.add(id);
    const operation = requireString(action.operation, 'action.operation', 128);
    if (!/^[a-z][a-z0-9_.-]{1,127}$/.test(operation))
      throw new Error('action.operation is invalid');
    validateStaticInput(action.input);
    if (action.eventMap !== undefined) {
      const mapping = asObject(action.eventMap, 'action.eventMap');
      for (const [target, source] of Object.entries(mapping)) {
        safeKey(target, 'action event target');
        safeKey(requireString(source, 'action event source', 64), 'action event source');
      }
    }
    if (action.confirmation !== undefined) {
      const confirmation = asObject(action.confirmation, 'action.confirmation');
      rejectUnknownKeys(confirmation, ['title', 'message'], 'action.confirmation');
      requireString(confirmation.title, 'confirmation.title', 200);
      requireString(confirmation.message, 'confirmation.message', 1_000);
    }
  }
  for (const actionId of collectButtonActions(document.root as UiNode)) {
    if (!actionIds.has(actionId))
      throw new Error(`Button references undeclared action ${actionId}`);
  }
  return structuredClone(document) as unknown as DeclarativeUiDocument;
}

export function validateUiEvent(value: unknown): JsonObject {
  const event = asObject(value, 'event');
  if (Object.keys(event).length > 32) throw new Error('event has too many fields');
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(event)) {
    safeKey(key, 'event field');
    if (Array.isArray(item)) {
      if (item.length > 100 || !item.every(isScalar))
        throw new Error(`event.${key} must contain scalar values`);
      if (item.some((entry) => typeof entry === 'string' && entry.length > 4_000))
        throw new Error(`event.${key} strings must not exceed 4000 characters`);
      result[key] = structuredClone(item);
    } else if (isScalar(item)) {
      if (typeof item === 'string' && item.length > 4_000)
        throw new Error(`event.${key} must not exceed 4000 characters`);
      result[key] = item;
    } else {
      throw new Error(`event.${key} must be a scalar or scalar array`);
    }
  }
  return result;
}

export function buildActionInput(action: UiActionBinding, event: JsonObject): JsonObject {
  const result: JsonObject = structuredClone(action.input ?? {});
  for (const [target, source] of Object.entries(action.eventMap ?? {})) {
    if (Object.hasOwn(event, source)) result[target] = event[source];
  }
  return result;
}

function validateNode(
  value: unknown,
  depth: number,
  state: { nodes: number; ids: Set<string>; tableCells: number },
  limits: UiValidationLimits,
): void {
  if (depth > (limits.maxDepth ?? 20)) throw new Error('UI document exceeds maximum depth');
  if (++state.nodes > (limits.maxNodes ?? 500)) throw new Error('UI document has too many nodes');
  const node = asObject(value, 'node');
  const type = requireString(node.type, 'node.type', 32);
  if (!NODE_TYPES.has(type)) throw new Error(`Unsupported UI node type ${type}`);
  rejectUnknownKeys(node, allowedNodeKeys(type), `${type} node`);
  const id = safeId(node.id, 'node.id');
  if (state.ids.has(id)) throw new Error(`Duplicate node id ${id}`);
  state.ids.add(id);
  validateStrings(node, limits.maxStringLength ?? 32_000);
  if (type === 'stack' || type === 'card') {
    if (type === 'stack') {
      enumValue(node.direction, ['vertical', 'horizontal'], 'stack.direction');
      enumValue(node.gap, ['none', 'small', 'medium', 'large'], 'stack.gap');
    } else if (node.title !== undefined) {
      requireString(node.title, 'card.title', 1_000);
    }
    for (const child of array(node.children, `${type}.children`))
      validateNode(child, depth + 1, state, limits);
  }
  if (type === 'heading') {
    requireString(node.text, 'heading.text', limits.maxStringLength ?? 32_000);
    if (node.level !== undefined && ![1, 2, 3].includes(node.level as number))
      throw new Error('heading.level must be 1, 2, or 3');
  }
  if (type === 'text' || type === 'badge') {
    requireString(node.text, `${type}.text`, limits.maxStringLength ?? 32_000);
    enumValue(
      node.tone,
      ['default', 'muted', 'success', 'warning', 'danger', 'info'],
      `${type}.tone`,
    );
  }
  if (type === 'button') {
    requireString(node.label, 'button.label', 1_000);
    safeId(node.actionId, 'button.actionId');
    enumValue(node.variant, ['primary', 'secondary', 'danger'], 'button.variant');
  }
  if (type === 'input') {
    safeKey(requireString(node.name, 'input.name', 64), 'input.name');
    requireString(node.label, 'input.label', 1_000);
    enumValue(node.inputType, ['text', 'number', 'email'], 'input.inputType');
    if (node.value !== undefined && !isScalar(node.value))
      throw new Error('input.value must be a scalar');
  }
  if (type === 'select') {
    safeKey(requireString(node.name, 'select.name', 64), 'select.name');
    requireString(node.label, 'select.label', 1_000);
    if (node.value !== undefined && !isScalar(node.value))
      throw new Error('select.value must be a scalar');
    const options = array(node.options, 'select.options');
    if (options.length > 200) throw new Error('select has too many options');
    for (const option of options) {
      const record = asObject(option, 'select.option');
      rejectUnknownKeys(record, ['label', 'value'], 'select.option');
      requireString(record.label, 'select.option.label', 1_000);
      if (!isScalar(record.value)) throw new Error('select.option.value must be a scalar');
    }
  }
  if (type === 'progress') {
    if (typeof node.value !== 'number' || node.value < 0 || node.value > 100)
      throw new Error('progress.value must be between 0 and 100');
    if (node.label !== undefined) requireString(node.label, 'progress.label', 1_000);
  }
  if (type === 'table') {
    const columns = array(node.columns, 'table.columns');
    const rows = array(node.rows, 'table.rows');
    if (!columns.length || columns.length > 50 || rows.length > 1_000)
      throw new Error('table dimensions are invalid');
    state.tableCells += columns.length * rows.length;
    if (state.tableCells > (limits.maxTableCells ?? 10_000))
      throw new Error('UI document has too many table cells');
    for (const column of columns) {
      const record = asObject(column, 'table.column');
      rejectUnknownKeys(record, ['key', 'label'], 'table.column');
      safeKey(requireString(record.key, 'table.column.key', 64), 'table.column.key');
      requireString(record.label, 'table.column.label', 1_000);
    }
    for (const row of rows)
      for (const [key, cell] of Object.entries(asObject(row, 'table.row'))) {
        safeKey(key, 'table cell key');
        if (!isScalar(cell)) throw new Error('table cells must be scalars');
      }
  }
}

function validateStrings(record: JsonObject, max: number): void {
  for (const [key, value] of Object.entries(record))
    if (typeof value === 'string' && value.length > max)
      throw new Error(`${key} exceeds ${max} characters`);
}

function validateStaticInput(value: unknown): void {
  if (value === undefined) return;
  for (const [key, item] of Object.entries(asObject(value, 'action.input'))) {
    safeKey(key, 'action input key');
    if (!isScalar(item) && !(Array.isArray(item) && item.length <= 100 && item.every(isScalar)))
      throw new Error('action inputs must be scalar values or arrays');
  }
}

function collectButtonActions(node: UiNode): string[] {
  if (node.type === 'button') return [node.actionId];
  if (node.type === 'stack' || node.type === 'card')
    return node.children.flatMap(collectButtonActions);
  return [];
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function safeId(value: unknown, field: string): string {
  const id = requireString(value, field, 128);
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error(`${field} is invalid`);
  return id;
}

function safeKey(value: string, field: string): string {
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(value) || BLOCKED_KEYS.has(value))
    throw new Error(`${field} is invalid`);
  return value;
}

function isScalar(value: unknown): value is UiScalar {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function allowedNodeKeys(type: string): readonly string[] {
  switch (type) {
    case 'stack':
      return ['type', 'id', 'direction', 'gap', 'children'];
    case 'card':
      return ['type', 'id', 'title', 'children'];
    case 'heading':
      return ['type', 'id', 'text', 'level'];
    case 'text':
    case 'badge':
      return ['type', 'id', 'text', 'tone'];
    case 'button':
      return ['type', 'id', 'label', 'actionId', 'variant'];
    case 'input':
      return ['type', 'id', 'name', 'label', 'inputType', 'value', 'placeholder'];
    case 'select':
      return ['type', 'id', 'name', 'label', 'value', 'options'];
    case 'progress':
      return ['type', 'id', 'value', 'label'];
    case 'divider':
      return ['type', 'id'];
    case 'table':
      return ['type', 'id', 'columns', 'rows'];
    default:
      return [];
  }
}

function rejectUnknownKeys(record: JsonObject, allowed: readonly string[], field: string): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(record))
    if (!allow.has(key)) throw new Error(`${field} contains unsupported field ${key}`);
}

function enumValue(value: unknown, allowed: readonly string[], field: string): void {
  if (value !== undefined && (typeof value !== 'string' || !allowed.includes(value))) {
    throw new Error(`${field} must be one of ${allowed.join(', ')}`);
  }
}
