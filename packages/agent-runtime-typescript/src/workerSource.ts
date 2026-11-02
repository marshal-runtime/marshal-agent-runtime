import { APP_SERVICES_HELPER_SOURCE } from './appServices.js';

export const INLINE_MODULE_WORKER_SOURCE = String.raw`
import vm from 'node:vm';
import { createRequire, isBuiltin } from 'node:module';
import { inspect } from 'node:util';
${APP_SERVICES_HELPER_SOURCE}

const pendingBrokerCalls = new Map();
let nextBrokerRequestId = 1;

function cloneJson(value, label) {
  if (value === undefined) {
    throw Object.assign(new TypeError(label + ' must be JSON-serializable; received undefined.'), {
      code: 'RESULT_NOT_SERIALIZABLE',
    });
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw Object.assign(new TypeError(label + ' must be JSON-serializable: ' + error.message), {
      code: 'RESULT_NOT_SERIALIZABLE',
    });
  }
  if (serialized === undefined) {
    throw Object.assign(new TypeError(label + ' must be JSON-serializable.'), {
      code: 'RESULT_NOT_SERIALIZABLE',
    });
  }
  return JSON.parse(serialized);
}

function send(message) {
  if (typeof process.send !== 'function') {
    throw new Error('Inline module worker requires a Node IPC channel.');
  }
  process.send(message);
}

function brokerCall(method, params) {
  const id = String(nextBrokerRequestId++);
  return new Promise((resolve, reject) => {
    pendingBrokerCalls.set(id, { resolve, reject });
    send({ kind: 'broker.request', id, method, params: cloneJson(params, 'Broker request') });
  });
}

function createRuntime() {
  return Object.freeze({
    search(query) {
      return brokerCall('search', { query });
    },
    invoke(capability, input = null) {
      if (typeof capability !== 'string' || capability.length === 0) {
        return Promise.reject(new TypeError('runtime.invoke requires a capability name.'));
      }

      return brokerCall('invoke', { capability, input });
    },
  });
}

function makeConsole() {
  const write = (stream, values) => {
    stream.write(values.map((value) =>
      typeof value === 'string' ? value : inspect(value, { depth: 5, colors: false })
    ).join(' ') + '\n');
  };
  return Object.freeze({
    log: (...values) => write(process.stdout, values),
    info: (...values) => write(process.stdout, values),
    debug: (...values) => write(process.stdout, values),
    warn: (...values) => write(process.stderr, values),
    error: (...values) => write(process.stderr, values),
  });
}

function packageNameFor(specifier) {
  if (specifier.startsWith('@')) {
    return specifier.split('/').slice(0, 2).join('/');
  }
  return specifier.split('/')[0];
}

function normalizeBuiltin(specifier) {
  return specifier.startsWith('node:') ? specifier.slice(5) : specifier;
}

function createControlledRequire(configuration) {
  const baseRequire = createRequire(configuration.requireBase);
  const allowedPackages = new Set(configuration.allowedPackages);
  const allowedBuiltins = new Set(configuration.allowedBuiltins);
  return (specifier) => {
    const builtin = isBuiltin(specifier) ? normalizeBuiltin(specifier) : undefined;
    if (builtin && (allowedBuiltins.has('*') || allowedBuiltins.has(builtin))) {
      return baseRequire('node:' + builtin);
    }
    if (allowedPackages.has('*') || allowedPackages.has(packageNameFor(specifier))) {
      return baseRequire(specifier);
    }
    const error = new Error('Runtime require denied for "' + specifier + '".');
    error.code = 'IMPORT_DENIED';
    throw error;
  };
}

async function execute(configuration) {
  if (configuration.mode === 'brokered') {
    return executeBrokered(configuration);
  }
  return executeTrusted(configuration);
}

function brokeredBootstrap() {
  'use strict';
  const bridge = globalThis.__marshalBridge;
  const input = JSON.parse(globalThis.__marshalInputJson);
  const selectedExport = JSON.parse(globalThis.__marshalEntrypointJson);
  const appServicesSnapshot = JSON.parse(globalThis.__marshalAppServicesJson);
  // A contextified ordinary host object exposes its host-realm constructor.
  // Remove the global prototype/constructor route before authored code runs;
  // constructors of inner-realm values remain subject to codeGeneration:false.
  Object.setPrototypeOf(globalThis, null);
  Object.defineProperty(globalThis, 'constructor', {
    value: undefined,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  delete globalThis.__marshalBridge;
  delete globalThis.__marshalInputJson;
  delete globalThis.__marshalEntrypointJson;
  delete globalThis.__marshalAppServicesJson;
  const encode = (value) => JSON.stringify(value);
  const decode = (value) => JSON.parse(value);
  const write = (level, values) => bridge.writeConsole(level, encode(values));
  globalThis.console = Object.freeze({
    log: (...values) => write('log', values),
    info: (...values) => write('info', values),
    debug: (...values) => write('debug', values),
    warn: (...values) => write('warn', values),
    error: (...values) => write('error', values),
  });
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    if (typeof callback !== 'function') throw new TypeError('setTimeout callback must be a function.');
    return bridge.setTimer('timeout', () => callback(...args), Math.max(0, Number(delay) || 0));
  };
  globalThis.clearTimeout = (id) => bridge.clearTimer(id);
  globalThis.setInterval = (callback, delay = 0, ...args) => {
    if (typeof callback !== 'function') throw new TypeError('setInterval callback must be a function.');
    return bridge.setTimer('interval', () => callback(...args), Math.max(0, Number(delay) || 0));
  };
  globalThis.clearInterval = (id) => bridge.clearTimer(id);
  globalThis.queueMicrotask = (callback) => Promise.resolve().then(callback);
  const callBroker = async (method, params) => {
    const envelope = decode(await bridge.broker(method, encode(params)));
    if (envelope.ok) return envelope.value;
    const error = new Error(envelope.error?.message || 'Capability broker call failed.');
    error.code = envelope.error?.code || 'BROKER_ERROR';
    throw error;
  };
  const runtime = Object.freeze({
    search: (query) => callBroker('search', { query }),
    invoke: (capability, capabilityInput = null) => {
      if (typeof capability !== 'string' || capability.length === 0) {
        return Promise.reject(new TypeError('runtime.invoke requires a capability name.'));
      }
      return callBroker('invoke', { capability, input: capabilityInput });
    },
  });
  const appServices = createAppServices(callBroker, appServicesSnapshot);
  globalThis.AppServices = appServices;
  globalThis.TypeSymbols = createTypeSymbols(appServicesSnapshot);
  const moduleRecord = { exports: {} };
  globalThis.module = moduleRecord;
  globalThis.exports = moduleRecord.exports;
  return async () => {
    const exported = moduleRecord.exports;
    const entry = selectedExport
      ? exported[selectedExport]
      : typeof exported === 'function'
        ? exported
        : typeof exported.default === 'function'
          ? exported.default
          : exported.run;
    if (typeof entry !== 'function') {
      const error = new TypeError(selectedExport
        ? 'Module export "' + selectedExport + '" is not a function.'
        : 'Module must export a default function or a named run function.');
      error.code = 'ENTRYPOINT_NOT_FOUND';
      throw error;
    }
    const value = await entry(input, Object.freeze({ runtime, appServices, AppServices: appServices }));
    return JSON.stringify(value === undefined ? null : value);
  };
}

async function executeBrokered(configuration) {
  const activeTimers = new Map();
  let nextTimerId = 1;
  const bridge = Object.freeze({
    writeConsole(level, serializedValues) {
      try {
        const values = JSON.parse(serializedValues);
        const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
        stream.write(values.map((value) =>
          typeof value === 'string' ? value : inspect(value, { depth: 5, colors: false })
        ).join(' ') + '\n');
      } catch {
        // Console formatting is observational and cannot expose host objects.
      }
    },
    async broker(method, serializedParams) {
      try {
        const value = await brokerCall(method, JSON.parse(serializedParams));
        return JSON.stringify({ ok: true, value: cloneJson(value, 'Broker response') });
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: {
            code: typeof error?.code === 'string' ? error.code : 'BROKER_ERROR',
            message: typeof error?.message === 'string' ? error.message : 'Capability broker call failed.',
          },
        });
      }
    },
    setTimer(kind, callback, delay) {
      const id = nextTimerId++;
      const run = () => {
        if (kind === 'timeout') activeTimers.delete(id);
        try {
          callback();
        } catch {
          // User callback errors remain inside the context's promise/task graph.
        }
      };
      const handle = kind === 'interval' ? setInterval(run, delay) : setTimeout(run, delay);
      activeTimers.set(id, { kind, handle });
      return id;
    },
    clearTimer(id) {
      const timer = activeTimers.get(id);
      if (!timer) return;
      activeTimers.delete(id);
      if (timer.kind === 'interval') clearInterval(timer.handle);
      else clearTimeout(timer.handle);
    },
  });
  const context = vm.createContext(Object.create(null), {
    name: 'agent-runtime-brokered-module',
    codeGeneration: { strings: false, wasm: false },
  });
  Object.defineProperty(context, '__marshalBridge', {
    value: bridge,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(context, '__marshalInputJson', {
    value: JSON.stringify(cloneJson(configuration.input ?? null, 'Inline module input')),
    configurable: true,
  });
  Object.defineProperty(context, '__marshalEntrypointJson', {
    value: JSON.stringify(configuration.entrypoint ?? null),
    configurable: true,
  });
  Object.defineProperty(context, '__marshalAppServicesJson', {
    value: JSON.stringify(cloneJson(configuration.appServices ?? { services: [] }, 'App services snapshot')),
    configurable: true,
  });
  const bootstrapSource = '(' + brokeredBootstrap.toString() + ')()';
  const bootstrap = new vm.Script(
    bootstrapSource.replace("'use strict';", "'use strict';\n" + ${JSON.stringify(APP_SERVICES_HELPER_SOURCE)}),
    {
    filename: 'marshal-brokered-bootstrap.js',
    },
  );
  const invoke = bootstrap.runInContext(context);
  try {
    new vm.Script(configuration.compiledCode, { filename: configuration.filename }).runInContext(context);
    return cloneJson(JSON.parse(await invoke()), 'Inline module result');
  } finally {
    for (const id of [...activeTimers.keys()]) bridge.clearTimer(id);
  }
}

async function executeTrusted(configuration) {
  const compiledCode = configuration.compiledCode;
  const moduleRecord = { exports: {} };
  const sandbox = {
    module: moduleRecord,
    exports: moduleRecord.exports,
    console: makeConsole(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    structuredClone,
    AppServices: createAppServices(brokerCall, configuration.appServices),
    TypeSymbols: createTypeSymbols(configuration.appServices),
  };

  sandbox.process = process;
  sandbox.Buffer = Buffer;
  sandbox.require = createControlledRequire(configuration);

  const context = vm.createContext(sandbox, {
    name: 'agent-runtime-inline-module',
    codeGeneration: {
      strings: true,
      wasm: false,
    },
  });
  const script = new vm.Script(compiledCode, {
    filename: configuration.filename,
  });
  script.runInContext(context);

  const exported = moduleRecord.exports;
  const selectedExport = configuration.entrypoint;
  const entry = selectedExport
    ? exported[selectedExport]
    : typeof exported === 'function'
      ? exported
      : typeof exported.default === 'function'
        ? exported.default
        : exported.run;
  if (typeof entry !== 'function') {
    const error = new TypeError(selectedExport
      ? 'Module export "' + selectedExport + '" is not a function.'
      : 'Module must export a default function or a named run function.');
    error.code = 'ENTRYPOINT_NOT_FOUND';
    throw error;
  }

  const runtime = createRuntime();
  const appServices = createAppServices(brokerCall, configuration.appServices);
  const value = await entry(
    configuration.input,
    Object.freeze({ runtime, appServices, AppServices: appServices }),
  );
  return cloneJson(value === undefined ? null : value, 'Inline module result');
}

process.on('message', (message) => {
  if (!message || message.kind !== 'broker.response') {
    return;
  }
  const pending = pendingBrokerCalls.get(message.id);
  if (!pending) {
    return;
  }
  pendingBrokerCalls.delete(message.id);
  if (message.ok) {
    pending.resolve(message.value);
  } else {
    const error = new Error(message.error?.message || 'Capability broker call failed.');
    error.code = message.error?.code || 'BROKER_ERROR';
    pending.reject(error);
  }
});

const idleTimeout = setTimeout(() => process.exit(0), 5_000);
send({ kind: 'worker.ready' });

process.once('message', async (message) => {
  if (!message || message.kind !== 'execution.start') {
    return;
  }
  clearTimeout(idleTimeout);
  try {
    const value = await execute(message.configuration);
    send({ kind: 'execution.result', ok: true, value });
  } catch (error) {
    const errorRecord = error && typeof error === 'object' ? error : undefined;
    send({
      kind: 'execution.result',
      ok: false,
      error: {
        code: typeof errorRecord?.code === 'string' ? errorRecord.code : 'RUNTIME_ERROR',
        message: typeof errorRecord?.message === 'string' ? errorRecord.message : String(error),
        stack: typeof errorRecord?.stack === 'string' ? errorRecord.stack : undefined,
      },
    });
  }
});
`;
