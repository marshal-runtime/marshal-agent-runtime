import { createRuntimeServiceToken } from '@marshal/agent-runtime-composer';
import type { InvocationContext } from '@marshal/agent-runtime-core';
import type { UiApplicationManifest } from '../applicationTypes.js';
import type { JsonObject } from '../types.js';

export type UiApplicationScope = 'workspace' | 'project' | 'session';
export type UiApplicationMetadata = Readonly<JsonObject>;

/** The principal and exactly one effective render-declared scope. */
export interface UiApplicationOwner {
  readonly principalId: string;
  readonly scope: UiApplicationScope;
  readonly scopeId: string;
}

/** Stable identity for the application across immutable revisions. */
export interface UiApplicationIdentity {
  readonly id: string;
}

/** How an authored application and its executable UI revision were produced. */
export interface UiApplicationSourceProvenance {
  readonly kind: 'workspace_file' | 'registered_component' | 'authored_typescript' | 'snapshot';
  readonly path?: string;
  readonly sourceDigest: string;
  readonly componentId: string;
  readonly renderId: string;
  readonly componentDigest: string;
  readonly renderDigest: string;
}

/** Full immutable application record returned by the state service. */
export interface UiApplicationSnapshot {
  readonly identity: UiApplicationIdentity;
  readonly owner: UiApplicationOwner;
  readonly title?: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly metadata: UiApplicationMetadata;
  readonly application: UiApplicationManifest;
  readonly props: JsonObject;
  readonly provenance: UiApplicationSourceProvenance;
  readonly state: JsonObject;
  readonly version: number;
  readonly snapshotDigest: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Bounded listing projection; executable application state is not exposed here. */
export interface UiApplicationSummary {
  readonly identity: UiApplicationIdentity;
  readonly owner: UiApplicationOwner;
  readonly title?: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly metadata: UiApplicationMetadata;
  readonly version: number;
  readonly snapshotDigest: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UiApplicationCreationRequest {
  readonly identity?: Pick<UiApplicationIdentity, 'id'>;
  readonly title?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly metadata?: JsonObject;
  readonly application: UiApplicationManifest;
  readonly props?: JsonObject;
  readonly provenance: UiApplicationSourceProvenance;
  readonly initialState?: JsonObject;
}

export interface UiApplicationUpdateRequest {
  readonly expectedVersion: number;
  readonly title?: string | null;
  readonly description?: string | null;
  /** Replace tags, or remove them with null. */
  readonly tags?: readonly string[] | null;
  /** Replace metadata, or remove it with null. */
  readonly metadata?: JsonObject | null;
  /** Revision fields must be supplied together. */
  readonly application?: UiApplicationManifest;
  readonly props?: JsonObject;
  readonly provenance?: UiApplicationSourceProvenance;
}

export interface RuntimeAuthoredUiStateService {
  create(
    request: UiApplicationCreationRequest,
    context: InvocationContext,
  ): Promise<UiApplicationSnapshot>;
  read(
    id: string,
    context: InvocationContext,
  ): Promise<UiApplicationSnapshot | undefined>;
  list(context: InvocationContext): Promise<readonly UiApplicationSummary[]>;
  update(
    id: string,
    request: UiApplicationUpdateRequest,
    context: InvocationContext,
  ): Promise<UiApplicationSnapshot>;
  changeState(
    id: string,
    state: JsonObject,
    expectedVersion: number,
    context: InvocationContext,
  ): Promise<UiApplicationSnapshot>;
  readSnapshot(
    id: string,
    snapshotDigest: string,
    context: InvocationContext,
  ): Promise<UiApplicationSnapshot | undefined>;
  remove(
    id: string,
    expectedVersion: number,
    context: InvocationContext,
  ): Promise<boolean>;
  migrate(
    request: UiApplicationCreationRequest,
    context: InvocationContext,
  ): Promise<UiApplicationSnapshot>;
}

export const RUNTIME_AUTHORED_UI_STATE_SERVICE =
  createRuntimeServiceToken<RuntimeAuthoredUiStateService>(
    '@marshal/agent-runtime-ui:authored-state',
  );
