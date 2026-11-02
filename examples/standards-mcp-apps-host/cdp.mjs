import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROWSER_CANDIDATES = process.platform === 'win32'
  ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];

export async function launchCdpBrowser(options = {}) {
  const executable = options.executable ?? await firstExisting(BROWSER_CANDIDATES);
  if (!executable) throw new Error('Chrome or Edge was not found; pass --browser with an absolute executable path.');
  const userDataRoot = await mkdtemp(join(tmpdir(), 'marshal-standards-host-browser-'));
  const child = spawn(executable, [
    '--headless=new',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-gpu',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-default-browser-check',
    '--no-first-run',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataRoot}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const activePortPath = join(userDataRoot, 'DevToolsActivePort');
  const activePort = await waitForFile(activePortPath, 15_000, child);
  const [portLine, browserPath] = activePort.trim().split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || !browserPath) throw new Error('Browser emitted an invalid DevToolsActivePort file.');
  const connection = await CdpConnection.connect(`ws://127.0.0.1:${port}${browserPath}`);
  const { targetId } = await connection.call('Target.createTarget', { url: 'about:blank' });
  const attached = await connection.call('Target.attachToTarget', { targetId, flatten: true });
  const session = new CdpPage(connection, attached.sessionId);
  await session.initialize();
  return {
    executable,
    processId: child.pid,
    browser: child,
    page: session,
    async close() {
      await connection.call('Browser.close').catch(() => undefined);
      await waitForExit(child, 5_000).catch(() => child.kill());
      connection.close();
      await rm(userDataRoot, { recursive: true, force: true });
    },
  };
}

class CdpPage {
  #contexts = new Map();
  #exceptions = [];
  #sessions = new Set();
  #unsubscribe;

  constructor(connection, sessionId) {
    this.connection = connection;
    this.sessionId = sessionId;
  }

  async initialize() {
    this.#sessions.add(this.sessionId);
    this.#unsubscribe = this.connection.subscribe((message) => {
      if (message.sessionId === this.sessionId && message.method === 'Target.attachedToTarget') {
        const childSessionId = message.params?.sessionId;
        if (typeof childSessionId === 'string') {
          this.#sessions.add(childSessionId);
          void this.connection.call('Runtime.enable', {}, childSessionId).catch(() => undefined);
          void this.connection.call('Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
          }, childSessionId).catch(() => undefined);
        }
      }
      if (!this.#sessions.has(message.sessionId)) return;
      if (message.method === 'Runtime.executionContextCreated') {
        const context = message.params?.context;
        if (context?.id) this.#contexts.set(`${message.sessionId}:${context.id}`, { context, sessionId: message.sessionId });
      }
      if (message.method === 'Runtime.executionContextsCleared') {
        for (const [key, item] of this.#contexts) {
          if (item.sessionId === message.sessionId) this.#contexts.delete(key);
        }
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.#exceptions.push(message.params?.exceptionDetails);
      }
    });
    await this.connection.call('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }, this.sessionId);
    await this.connection.call('Page.enable', {}, this.sessionId);
    await this.connection.call('Runtime.enable', {}, this.sessionId);
  }

  async navigate(url) {
    const loaded = this.connection.waitFor(
      (message) => message.sessionId === this.sessionId && message.method === 'Page.loadEventFired',
      20_000,
    );
    await this.connection.call('Page.navigate', { url }, this.sessionId);
    await loaded;
  }

  async setViewport(width, height, deviceScaleFactor = 1) {
    await this.connection.call('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile: false,
    }, this.sessionId);
  }

  async find(selector, predicate = () => true, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let last = [];
    while (Date.now() < deadline) {
      last = [];
      for (const item of this.#contexts.values()) {
        const { context, sessionId } = item;
        if (context.auxData?.isDefault === false) continue;
        try {
          const evaluated = await this.connection.call('Runtime.evaluate', {
            contextId: context.id,
            expression: `(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)return null;const rect=node.getBoundingClientRect(),active=document.activeElement;return{text:node.textContent||'',value:'value'in node?node.value:null,className:String(node.className||''),hidden:node.hidden,disabled:Boolean(node.disabled),display:getComputedStyle(node).display,width:rect.width,height:rect.height,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,clientWidth:document.documentElement.clientWidth,documentScrollWidth:document.documentElement.scrollWidth,documentScrollHeight:document.documentElement.scrollHeight,activeKey:active&&active.dataset?active.dataset.chromeKey||null:null};})()`,
            returnByValue: true,
            awaitPromise: true,
          }, sessionId);
          const value = evaluated.result?.value;
          if (value) {
            const match = { contextId: context.id, frameId: context.auxData?.frameId, sessionId, value };
            last.push(match);
            if (predicate(value)) return match;
          }
        } catch {
          // A frame can disappear while remounting; retry against the new context.
        }
      }
      await delay(50);
    }
    throw new Error(`Timed out waiting for ${selector}; last matches: ${JSON.stringify(last)}; diagnostics: ${JSON.stringify(await this.diagnostics())}`);
  }

  async diagnostics() {
    const contexts = [];
    for (const item of this.#contexts.values()) {
      const { context, sessionId } = item;
      try {
        const evaluated = await this.connection.call('Runtime.evaluate', {
          contextId: context.id,
          expression: `({url:location.href,title:document.title,ready:document.readyState,body:(document.body&&document.body.innerText||'').slice(0,500)})`,
          returnByValue: true,
        }, sessionId);
        contexts.push({ id: context.id, sessionId, frameId: context.auxData?.frameId, value: evaluated.result?.value });
      } catch (error) {
        contexts.push({ id: context.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { contexts, exceptions: this.#exceptions.slice(-10) };
  }

  async click(selector, predicate = () => true) {
    const match = await this.find(selector, predicate);
    const evaluated = await this.connection.call('Runtime.evaluate', {
      contextId: match.contextId,
      expression: `(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)return false;node.scrollIntoView({block:'center',inline:'center'});node.click();return true;})()`,
      returnByValue: true,
      awaitPromise: true,
      }, match.sessionId);
    if (evaluated.result?.value !== true) throw new Error(`Could not activate ${selector}.`);
    return { selector, contextId: match.contextId, frameId: match.frameId, activation: 'dom-click' };
  }

  async evaluateWhere(selector, expression, predicate = () => true) {
    const match = await this.find(selector, predicate);
    const evaluated = await this.connection.call('Runtime.evaluate', {
      contextId: match.contextId,
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, match.sessionId);
    if (evaluated.exceptionDetails) throw new Error(`Evaluation failed for ${selector}: ${JSON.stringify(evaluated.exceptionDetails)}`);
    return evaluated.result?.value;
  }

  async screenshot(path) {
    const captured = await this.connection.call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: true,
    }, this.sessionId);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, Buffer.from(captured.data, 'base64'));
  }

  async close() {
    this.#unsubscribe?.();
  }
}

class CdpConnection {
  #sequence = 0;
  #pending = new Map();
  #listeners = new Set();
  #socket;

  static async connect(url) {
    const connection = new CdpConnection();
    await connection.#open(url);
    return connection;
  }

  async #open(url) {
    this.#socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      this.#socket.addEventListener('open', resolve, { once: true });
      this.#socket.addEventListener('error', reject, { once: true });
    });
    this.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }));
        else pending.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.#listeners) listener(message);
    });
    this.#socket.addEventListener('close', () => {
      const error = new Error('Chrome DevTools Protocol connection closed.');
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  call(method, params = {}, sessionId) {
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP request timed out: ${method}`));
      }, 30_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  waitFor(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error('Timed out waiting for Chrome DevTools Protocol event.'));
      }, timeoutMs);
      const unsubscribe = this.subscribe((message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(message);
      });
    });
  }

  close() {
    this.#socket?.close();
  }
}

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      if ((await stat(path)).isFile()) return path;
    } catch {
      // Continue to the next known browser location.
    }
  }
  return undefined;
}

async function waitForFile(path, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Browser exited before DevTools startup with code ${child.exitCode}.`);
    try {
      return await readFile(path, 'utf8');
    } catch {
      await delay(50);
    }
  }
  throw new Error('Timed out waiting for browser DevTools startup.');
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return child.exitCode;
  return await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(timeoutMs).then(() => { throw new Error('Timed out waiting for browser exit.'); }),
  ]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
