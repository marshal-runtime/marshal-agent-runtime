import {
  MARSHAL_UI_CLIENT_VERSION,
  MCP_APPS_PROTOCOL_VERSION,
  UI_ACTION_TOOL_NAME,
  UI_CHROME_ACTION_BINDING_METHOD,
  UI_CHROME_ACTION_CANCEL_METHOD,
  UI_CHROME_ACTION_REQUEST_METHOD,
  UI_CHROME_ACTION_RESULT_METHOD,
  UI_CHROME_ACTION_TIMEOUT_MS,
  UI_DECLARED_TOOL_NAME,
  type UiActionResult,
  type UiActionActivation,
  type UiApplicationManifest,
  type UiChromeActionContext,
  type UiChromeActionResult,
  type UiClientOptions,
  type UiDeclaredToolReference,
  type UiDeclaredToolResult,
  type UiDisplayMode,
  type UiDisplayModeResult,
  type UiHostCapabilities,
  type UiHostExtensionCallResult,
  type UiHostContext,
  type UiLifecycleEvent,
  type UiMessage,
  type UiModelContextUpdate,
  type UiOpenLinkRequest,
  type UiProtocolMessage,
  type UiProtocolTransport,
  type UiStateScope,
} from './applicationTypes.js';
import { assertUiSchema } from './schemaValidation.js';

interface UiInitializeResult {
  protocolVersion?: string;
  hostCapabilities?: UiHostCapabilities;
  hostContext?: Partial<UiHostContext>;
}

export class MarshalUiClient {
  private readonly listeners = new Set<(event: UiLifecycleEvent) => void>();
  private readonly tools = new Map<string, UiDeclaredToolReference>();
  private readonly actions = new Map<string, UiApplicationManifest['actions'][number]>();
  private readonly chromeActionBindings = new Map<string, (context: UiChromeActionContext) => Promise<unknown> | unknown>();
  private readonly chromeActionRequestIds = new Set<string>();
  private readonly pendingChromeActionIds = new Set<string>();
  private readonly pendingChromeActionControllers = new Map<string, {
    actionId: string;
    controller: AbortController;
  }>();
  private readonly activeChromeActivations = new Map<string, Pick<UiActionActivation, 'requestId' | 'activatedAt'>>();
  private unsubscribe?: () => void;
  private disposed = false;
  private hostContext: UiHostContext = {
    displayMode: 'inline',
    availableDisplayModes: ['inline'],
  };
  private hostCapabilities: UiHostCapabilities = {};

  private constructor(private readonly options: UiClientOptions) {
    for (const tool of options.application.tools) this.tools.set(tool.id, tool);
    for (const action of options.application.actions) this.actions.set(action.id, action);
  }

  static async connect(options: UiClientOptions): Promise<MarshalUiClient> {
    const client = new MarshalUiClient(options);
    client.unsubscribe = options.transport.subscribe((message) => client.receive(message));
    const initialized = await options.transport.request<UiInitializeResult>('ui/initialize', {
      protocolVersion: MCP_APPS_PROTOCOL_VERSION,
      appInfo: { ...options.appInfo, marshalClientVersion: MARSHAL_UI_CLIENT_VERSION },
      appCapabilities: { availableDisplayModes: options.application.presentationModes },
    });
    client.hostCapabilities = initialized.hostCapabilities ?? {};
    client.hostContext = normalizeHostContext(initialized.hostContext);
    options.transport.notify('ui/notifications/initialized', {});
    return client;
  }

  get host(): Readonly<{ context: UiHostContext; capabilities: UiHostCapabilities; displayMode: UiDisplayMode }> {
    return { context: this.hostContext, capabilities: this.hostCapabilities, displayMode: this.hostContext.displayMode };
  }

  async callAction<TInput, TOutput>(
    actionId: string,
    input: TInput,
    options: {
      scope?: UiStateScope;
      idempotencyKey?: string;
      approval?: Readonly<Record<string, unknown>>;
      signal?: AbortSignal;
    } = {},
  ): Promise<UiActionResult<TOutput>> {
    this.assertActive();
    const action = this.actions.get(actionId);
    if (!action) throw new Error(`UI action ${actionId} is not declared by this application`);
    assertUiSchema(input, action.inputSchema, `action.${actionId}.input`);
    const scope = options.scope ?? action.allowedScopes[0];
    if (!scope || !action.allowedScopes.includes(scope)) throw new Error(`UI action ${actionId} does not allow ${String(scope)} scope`);
    if (action.idempotency === 'required' && !options.idempotencyKey) throw new Error(`UI action ${actionId} requires an idempotency key`);
    const called = await this.options.transport.request<{ structuredContent?: UiActionResult<TOutput> } | UiActionResult<TOutput>>('tools/call', {
      name: UI_ACTION_TOOL_NAME,
      arguments: {
        renderId: this.options.renderId,
        actionId,
        input,
        scope,
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        ...(options.approval ? { approval: options.approval } : {}),
        ...(this.activeChromeActivations.get(actionId)
          ? { activationRequestId: this.activeChromeActivations.get(actionId)!.requestId }
          : {}),
      },
    }, { signal: options.signal });
    const result = ('structuredContent' in called && called.structuredContent ? called.structuredContent : called) as UiActionResult<TOutput>;
    if (result.output !== undefined) assertUiSchema(result.output, action.outputSchema, `action.${actionId}.output`);
    return result;
  }

  /**
   * Bind a manifest-derived renderer-chrome control to the component's current
   * stateful action handler. The outer control remains visible even when
   * authored CSS hides the component's own toolbar, while this callback keeps
   * input construction and exactly-once invocation inside the application.
   */
  bindActionControl(
    actionId: string,
    handler: (context: UiChromeActionContext) => Promise<unknown> | unknown,
  ): () => void {
    this.assertActive();
    if (!this.actions.has(actionId)) throw new Error(`UI action ${actionId} is not declared by this application`);
    if (typeof handler !== 'function') throw new TypeError('UI action control handler must be a function');
    this.chromeActionBindings.set(actionId, handler);
    this.options.transport.notify(UI_CHROME_ACTION_BINDING_METHOD, { actionId, bound: true });
    return () => {
      if (this.chromeActionBindings.get(actionId) !== handler) return;
      this.chromeActionBindings.delete(actionId);
      if (!this.disposed) this.options.transport.notify(UI_CHROME_ACTION_BINDING_METHOD, { actionId, bound: false });
    };
  }

  async callTool<TInput, TOutput>(reference: UiDeclaredToolReference<TInput, TOutput> | string, input: TInput): Promise<TOutput> {
    this.assertActive();
    const tool = typeof reference === 'string' ? this.tools.get(reference) : this.tools.get(reference.id);
    if (!tool || (typeof reference !== 'string' && tool.name !== reference.name)) throw new Error('UI tool is not declared by this application');
    assertUiSchema(input, tool.inputSchema, `tool.${tool.id}.input`);
    const called = await this.options.transport.request<{
      structuredContent?: UiDeclaredToolResult<TOutput>;
    } | UiDeclaredToolResult<TOutput>>('tools/call', {
      name: UI_DECLARED_TOOL_NAME,
      arguments: { renderId: this.options.renderId, toolId: tool.id, input },
    });
    const result = ('structuredContent' in called && called.structuredContent
      ? called.structuredContent
      : called) as UiDeclaredToolResult<TOutput>;
    if (result.status !== 'success') {
      throw Object.assign(
        new Error(result.error?.message ?? `UI tool ${tool.id} ended with ${result.status}.`),
        { code: result.error?.code ?? 'UI_DECLARED_TOOL_FAILED', result },
      );
    }
    const output = result.output as TOutput;
    if (tool.outputSchema) assertUiSchema(output, tool.outputSchema, `tool.${tool.id}.output`);
    return output;
  }

  async sendMessage(message: UiMessage): Promise<void> {
    this.assertActive();
    await this.options.transport.request('ui/message', message);
  }

  async updateModelContext(update: UiModelContextUpdate): Promise<void> {
    this.assertActive();
    await this.options.transport.request('ui/update-model-context', update);
  }

  async openLink(request: UiOpenLinkRequest): Promise<{ opened: boolean }> {
    this.assertActive();
    return this.options.transport.request('ui/open-link', request);
  }

  supportsHostExtension(namespace: string, method: string): boolean {
    const extension = record(this.hostCapabilities.extensions?.[namespace]);
    return Array.isArray(extension.methods) && extension.methods.includes(method);
  }

  async callHostExtension<TResult = unknown>(
    namespace: string,
    method: string,
    args: readonly unknown[] = [],
  ): Promise<UiHostExtensionCallResult<TResult>> {
    this.assertActive();
    if (!this.supportsHostExtension(namespace, method)) {
      return { namespace, method, status: 'unsupported' };
    }
    try {
      return await this.options.transport.request<UiHostExtensionCallResult<TResult>>(
        'marshal/extensions/call',
        { namespace, method, args },
      );
    } catch (error) {
      return {
        namespace,
        method,
        status: 'failed',
        error: { message: error instanceof Error ? error.message : 'Host extension failed.' },
      };
    }
  }

  async requestDisplayMode(mode: UiDisplayMode): Promise<UiDisplayModeResult> {
    this.assertActive();
    const current = this.hostContext.displayMode;
    if (!this.options.application.presentationModes.includes(mode)) {
      return { requested: mode, actual: current, status: 'unsupported', reason: 'Application did not declare this display mode.' };
    }
    if (!this.hostContext.availableDisplayModes.includes(mode)) {
      return { requested: mode, actual: current, status: 'unsupported', reason: 'Host did not advertise this display mode.' };
    }
    try {
      const result = await this.options.transport.request<{
        mode?: UiDisplayMode;
        /** Compatibility alias used by pre-standard Marshal hosts. */
        displayMode?: UiDisplayMode;
      }>('ui/request-display-mode', { mode });
      const actual = isDisplayMode(result.mode)
        ? result.mode
        : isDisplayMode(result.displayMode)
          ? result.displayMode
          : this.hostContext.displayMode;
      this.hostContext = { ...this.hostContext, displayMode: actual };
      return { requested: mode, actual, status: actual === mode ? 'granted' : 'fallback', ...(actual === mode ? {} : { reason: `Host selected ${actual}.` }) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Host denied the display-mode request.';
      return {
        requested: mode,
        actual: current,
        status: /timed out/i.test(reason) ? 'timed_out' : 'denied',
        reason,
      };
    }
  }

  reportSize(dimensions: { width?: number; height?: number }): void {
    this.assertActive();
    const params: Record<string, number> = {};
    if (finite(dimensions.width)) params.width = Math.ceil(dimensions.width);
    if (finite(dimensions.height)) params.height = Math.ceil(dimensions.height);
    if (Object.keys(params).length > 0) this.options.transport.notify('ui/notifications/size-changed', params);
  }

  subscribe(listener: (event: UiLifecycleEvent) => void): () => void {
    this.assertActive();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pendingChromeActionControllers.values()) {
      pending.controller.abort('Marshal UI client torn down.');
    }
    this.pendingChromeActionControllers.clear();
    this.unsubscribe?.();
    this.listeners.clear();
  }

  private receive(message: UiProtocolMessage): void {
    if (!message.method) return;
    const params = record(message.params);
    switch (message.method) {
      case 'ui/notifications/tool-input': this.emit({ type: 'tool-input', input: params }); break;
      case 'ui/notifications/tool-input-partial': this.emit({ type: 'tool-input-partial', input: params }); break;
      case 'ui/notifications/tool-result': this.emit({ type: 'tool-result', result: params }); break;
      case 'ui/notifications/tool-cancelled': this.emit({ type: 'tool-cancelled', ...(typeof params.reason === 'string' ? { reason: params.reason } : {}) }); break;
      case 'ui/notifications/tool-error': this.emit({ type: 'tool-error', error: { message: typeof params.message === 'string' ? params.message : 'Tool failed.', ...(typeof params.code === 'string' ? { code: params.code } : {}), ...('details' in params ? { details: params.details } : {}) } }); break;
      case 'ui/notifications/host-context-changed': {
        this.hostContext = normalizeHostContext({ ...this.hostContext, ...params });
        this.emit({ type: 'host-context-changed', context: this.hostContext });
        break;
      }
      case UI_CHROME_ACTION_REQUEST_METHOD: {
        const requestId = typeof params.requestId === 'string' ? params.requestId : '';
        const actionId = typeof params.actionId === 'string' ? params.actionId : '';
        const activatedAt = validTimestamp(params.activatedAt)
          ? params.activatedAt
          : new Date().toISOString();
        if (requestId && actionId && !this.chromeActionRequestIds.has(requestId)) {
          this.chromeActionRequestIds.add(requestId);
          if (this.chromeActionRequestIds.size > 512) this.chromeActionRequestIds.delete(this.chromeActionRequestIds.values().next().value!);
          if (this.pendingChromeActionIds.has(actionId)) {
            this.options.transport.notify(UI_CHROME_ACTION_RESULT_METHOD, {
              requestId,
              actionId,
              status: 'unavailable',
              message: `${this.actions.get(actionId)?.title ?? actionId} is already running.`,
            });
          } else {
            this.pendingChromeActionIds.add(actionId);
            void this.invokeChromeAction(requestId, actionId, activatedAt).finally(() => this.pendingChromeActionIds.delete(actionId));
          }
        }
        break;
      }
      case UI_CHROME_ACTION_CANCEL_METHOD: {
        const requestId = typeof params.requestId === 'string' ? params.requestId : '';
        const actionId = typeof params.actionId === 'string' ? params.actionId : '';
        const pending = requestId ? this.pendingChromeActionControllers.get(requestId) : undefined;
        if (pending && actionId && pending.actionId === actionId) {
          pending.controller.abort('Application action cancelled by the user.');
        }
        break;
      }
      case 'ui/notifications/teardown':
        this.emit({ type: 'teardown', ...(typeof params.reason === 'string' ? { reason: params.reason } : {}) });
        this.close();
        break;
    }
  }

  private async invokeChromeAction(requestId: string, actionId: string, activatedAt: string): Promise<void> {
    const handler = this.chromeActionBindings.get(actionId);
    if (!handler) {
      this.options.transport.notify(UI_CHROME_ACTION_RESULT_METHOD, {
        requestId,
        actionId,
        status: 'unavailable',
        message: `${this.actions.get(actionId)?.title ?? actionId} is not bound by this application; use its inline control.`,
      });
      return;
    }
    const controller = new AbortController();
    this.pendingChromeActionControllers.set(requestId, { actionId, controller });
    this.activeChromeActivations.set(actionId, { requestId, activatedAt });
    const timeout = setTimeout(() => controller.abort('Application action timed out.'), UI_CHROME_ACTION_TIMEOUT_MS);
    try {
      const output = await Promise.race([
        Promise.resolve(handler({ requestId, actionId, activatedAt, signal: controller.signal })),
        abortPromise(controller.signal),
      ]);
      const outcome = record(output);
      const receipt = record(outcome.receipt);
      if (typeof outcome.status === 'string' && outcome.status !== 'success') {
        const error = record(outcome.error);
        const status = chromeActionStatus(outcome.status);
        this.options.transport.notify(UI_CHROME_ACTION_RESULT_METHOD, {
          requestId,
          actionId,
          status,
          message: typeof error.message === 'string'
            ? error.message
            : `${this.actions.get(actionId)?.title ?? actionId} ended with ${outcome.status}.`,
          ...(typeof receipt.receiptId === 'string' ? { receipt: receipt as unknown as UiActionResult['receipt'] } : {}),
        } satisfies UiChromeActionResult);
        return;
      }
      this.options.transport.notify(UI_CHROME_ACTION_RESULT_METHOD, {
        requestId,
        actionId,
        status: 'success',
        message: typeof receipt.receiptId === 'string'
          ? `${this.actions.get(actionId)?.title ?? actionId} completed · receipt ${receipt.receiptId}.`
          : `${this.actions.get(actionId)?.title ?? actionId} completed.`,
        ...(typeof receipt.receiptId === 'string' ? { receipt: receipt as unknown as UiActionResult['receipt'] } : {}),
      } satisfies UiChromeActionResult);
    } catch (error) {
      const timedOut = controller.signal.aborted && controller.signal.reason === 'Application action timed out.';
      this.options.transport.notify(UI_CHROME_ACTION_RESULT_METHOD, {
        requestId,
        actionId,
        status: timedOut ? 'timed_out' : controller.signal.aborted ? 'cancelled' : 'failed',
        message: timedOut
          ? `${this.actions.get(actionId)?.title ?? actionId} timed out.`
          : controller.signal.aborted
            ? `${this.actions.get(actionId)?.title ?? actionId} was cancelled.`
            : error instanceof Error ? error.message : `${actionId} failed.`,
      } satisfies UiChromeActionResult);
    } finally {
      clearTimeout(timeout);
      this.pendingChromeActionControllers.delete(requestId);
      this.activeChromeActivations.delete(actionId);
    }
  }

  private emit(event: UiLifecycleEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Marshal UI client has been torn down');
  }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

/** Public prop shape for agent-authored components hydrated by Marshal. */
export type MarshalUiComponentProps<TProps extends object = Record<string, never>> =
  TProps & { readonly marshal: MarshalUiClient };

/** Browser transport for a sandboxed MCP App communicating with its parent host. */
export function createWindowParentTransport(targetOrigin = '*', timeoutMs = 30_000): UiProtocolTransport {
  if (typeof window === 'undefined' || window.parent === window) {
    throw new Error('Window parent transport requires a sandboxed browser application');
  }
  let sequence = 0;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
    throw new RangeError('UI transport timeoutMs must be from 100 through 300000.');
  }
  const pending = new Map<string, {
    resolve(value: unknown): void;
    reject(reason: unknown): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const listeners = new Set<(message: UiProtocolMessage) => void>();
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent || !isProtocolMessage(event.data)) return;
    const message = event.data;
    if (message.id !== undefined && !message.method) {
      const request = pending.get(String(message.id));
      if (request) {
        pending.delete(String(message.id));
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      }
      return;
    }
    for (const listener of [...listeners]) listener(message);
  };
  window.addEventListener('message', receive, { passive: true });
  return {
    request<TResult>(method: string, params: unknown, options?: { signal?: AbortSignal }): Promise<TResult> {
      const id = `marshal-ui-${++sequence}`;
      return new Promise<TResult>((resolve, reject) => {
        if (options?.signal?.aborted) {
          reject(abortError(options.signal.reason));
          return;
        }
        const onAbort = () => {
          const request = pending.get(id);
          if (!request) return;
          pending.delete(id);
          clearTimeout(request.timer);
          window.parent.postMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }, targetOrigin);
          reject(abortError(options?.signal?.reason));
        };
        const timer = setTimeout(() => {
          pending.delete(id);
          options?.signal?.removeEventListener('abort', onAbort);
          window.parent.postMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }, targetOrigin);
          reject(new Error(`UI host request timed out: ${method}`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            options?.signal?.removeEventListener('abort', onAbort);
            resolve(value as TResult);
          },
          reject: (reason) => {
            options?.signal?.removeEventListener('abort', onAbort);
            reject(reason);
          },
          timer,
        });
        options?.signal?.addEventListener('abort', onAbort, { once: true });
        window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, targetOrigin);
      });
    },
    notify(method: string, params: unknown): void {
      window.parent.postMessage({ jsonrpc: '2.0', method, params }, targetOrigin);
    },
    subscribe(listener: (message: UiProtocolMessage) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && pending.size === 0) window.removeEventListener('message', receive);
      };
    },
  };
}

function normalizeHostContext(value: Partial<UiHostContext> | undefined): UiHostContext {
  const modes = Array.isArray(value?.availableDisplayModes) ? value.availableDisplayModes.filter(isDisplayMode) : ['inline'];
  const displayMode = isDisplayMode(value?.displayMode) ? value.displayMode : 'inline';
  return { ...(value ?? {}), displayMode, availableDisplayModes: modes.length > 0 ? [...new Set(modes)] : ['inline'] } as UiHostContext;
}
function isDisplayMode(value: unknown): value is UiDisplayMode { return value === 'inline' || value === 'fullscreen' || value === 'pip'; }
function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function isProtocolMessage(value: unknown): value is UiProtocolMessage { return typeof value === 'object' && value !== null && (value as { jsonrpc?: unknown }).jsonrpc === '2.0'; }
function chromeActionStatus(value: string): UiChromeActionResult['status'] {
  return ['not_found', 'unavailable', 'denied', 'approval_required', 'failed', 'cancelled', 'timed_out'].includes(value)
    ? value as UiChromeActionResult['status']
    : 'failed';
}
function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(abortError(signal.reason));
    else signal.addEventListener('abort', () => reject(abortError(signal.reason)), { once: true });
  });
}
function abortError(reason: unknown): Error {
  return Object.assign(new Error(typeof reason === 'string' ? reason : 'Operation cancelled.'), { name: 'AbortError' });
}
