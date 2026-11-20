// A second extension that embeds its own chrome-extension:// page (as Surfingkeys
// does) against the real Remote. Chrome refuses chrome.debugger on such tabs and
// detaches when the frame appears later. Disposable profile, local fixtures only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const chromePath =
  process.env.CHROME_PATH ||
  path.join(
    os.homedir(),
    'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  );
const relayRoot = process.env.RELAY_ROOT || path.resolve(root, '../zylos-browser-remote');
const { start } = require(path.join(relayRoot, 'src/index.js'));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'coco-foreign-frame-e2e-'));
process.env.BROWSER_REMOTE_KEY = 'ab'.repeat(32);
const clients = [],
  messages = [];
let relay, site;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(work) {
  let error;
  for (let n = 0; n < 150; n++) {
    try {
      const value = await work();
      if (value) return value;
    } catch (e) {
      error = e;
    }
    await sleep(100);
  }
  throw error || new Error('Condition did not match');
}
async function launch(name) {
  const profile = path.join(tmp, name);
  await fs.mkdir(profile, { recursive: true });
  await fs.rm(path.join(profile, 'DevToolsActivePort'), { force: true });
  const extension = globalThis.process.env.EXTENSION_DIR || path.join(root, '.output/chrome-mv3');
  // FOREIGN_EXTENSION_DIR may point at a locally built real extension (e.g. Surfingkeys).
  const foreign =
    globalThis.process.env.FOREIGN_EXTENSION_DIR ||
    path.join(root, 'tests/fixtures/foreign-ui-extension');
  const process = spawn(
    chromePath,
    [
      '--headless=new',
      ...(globalThis.process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-extensions-except=' + extension + ',' + foreign,
      '--load-extension=' + extension + ',' + foreign,
      '--user-data-dir=' + profile,
      '--remote-debugging-port=0',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const client = { process };
  clients.push(client);
  const url = await eventually(async () => {
    const lines = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'))
      .trim()
      .split('\n');
    return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
  });
  const socket = (client.socket = new WebSocket(url));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let counter = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)),
      call = pending.get(message.id);
    if (!call) return;
    clearTimeout(call.timer);
    pending.delete(message.id);
    message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result);
  });
  const cdp = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++counter;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timed out: ${method}`));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const worker = await eventually(async () =>
    (await cdp('Target.getTargets')).targetInfos.find(
      (t) =>
        t.type === 'service_worker' &&
        t.url.startsWith('chrome-extension://') &&
        t.url.endsWith('/background.js'),
    ),
  );
  const { targetId } = await cdp('Target.createTarget', {
    url: `chrome-extension://${new URL(worker.url).host}/sidepanel.html`,
  });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async (expression) => {
    const result = await cdp(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await cdp('Runtime.enable', {}, sessionId);
  await eventually(() => evaluate('!!globalThis.chrome?.runtime?.sendMessage'));
  const ask = async (message) => {
    const reply = await evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply.value;
  };
  const state = () => ask({ type: 'remote-state' });
  await ask({
    type: 'remote-save',
    relayUrl: `ws://127.0.0.1:${relay.ext.server.address().port}/ext`,
    key: 'ab'.repeat(32),
  });
  await eventually(async () => (await state()).connected);
  Object.assign(client, { ask, state, evaluate, cdp });
  return client;
}
async function close(client) {
  client.socket?.close();
  if (client.process.exitCode === null && client.process.signalCode === null) {
    const exited = once(client.process, 'exit');
    client.process.kill('SIGTERM');
    const timer = setTimeout(() => client.process.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
  }
}
try {
  site = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      `<!doctype html><title>Foreign frame page</title><h1>Foreign frame page</h1><button id="action" onclick="this.dataset.count=String(Number(this.dataset.count)+1)" data-count="0">Count action</button><button id="summon" onclick="postMessage('foreign-ui-inject','*')">Summon foreign UI</button>`,
    );
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  relay = await start({
    extPort: 0,
    agentPort: 0,
    monitor: true,
    onStop: async () => ({ ok: true }),
    onRequest: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });
  const client = await launch('profile');
  const post = async (endpoint, id, decision) =>
    (
      await fetch(`http://127.0.0.1:${relay.agent.server.address().port}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, id, decision }),
      })
    ).json();
  const act = async (request, actions) => {
    const result = await post(request.endpointId, request.request.id, { kind: 'actions', actions });
    assert.equal(result.ok, true, JSON.stringify(result));
    return { endpointId: result.next?.endpointId, request: result.next, result };
  };
  const ref = (request, text) =>
    request.request.execution.observation.page.text
      .split('\n')
      .find((line) => line.includes(JSON.stringify(text)))
      ?.match(/@[^\s]+/)?.[0];
  const open = async (query) => {
    const tab = await client.evaluate(
      `chrome.tabs.create({url:${JSON.stringify(`http://127.0.0.1:${site.address().port}/${query}`)},active:true})`,
    );
    await eventually(() =>
      client.evaluate(`chrome.tabs.get(${tab.id}).then(t=>t.status==='complete')`),
    );
    await sleep(300);
    return tab;
  };
  const frames = (tab) =>
    client.evaluate(
      `chrome.scripting.executeScript({target:{tabId:${tab.id}},func:()=>{let n=0;const walk=(r)=>{for(const e of r.querySelectorAll('*')){if(e instanceof HTMLIFrameElement&&e.src.startsWith('chrome-extension://'))n++;if(e.shadowRoot)walk(e.shadowRoot)}};walk(document);return n}}).then(r=>r[0].result)`,
    );
  const begin = async (tab, text) => {
    await client.ask({
      type: 'remote-chat-send',
      tabId: tab.id,
      windowId: tab.windowId,
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    return eventually(() => messages.find((message) => message.text === text));
  };
  const show = (value) => JSON.stringify(value).slice(0, 1500);

  const failures = [];
  const scenario = async (name, work) => {
    try {
      await work();
      console.log('PASS', name);
    } catch (error) {
      failures.push(name);
      console.log('FAIL', name, '-', error.message.slice(0, 600));
      await client.ask({ type: 'remote-stop' }).catch(() => {});
      await eventually(async () => !(await client.state()).loopActive).catch(() => {});
    }
  };
  const count = (tab) =>
    client.evaluate(
      `chrome.scripting.executeScript({target:{tabId:${tab.id}},func:()=>document.querySelector('#action').dataset.count}).then(r=>r[0].result)`,
    );
  // Inspect, explicitly select the foreign frame, reattach, then act on the page.
  const removeAndOperate = async (r, tab) => {
    const id = r.request.execution.recovery.recoveryId;
    r = await act(r, [{ method: 'inspect-recovery-frames', params: { recoveryId: id } }]);
    const candidates = r.request.execution.observation.inspection.candidates;
    console.log('inspection:', show(candidates));
    assert.equal(candidates.length, 1);
    r = await act(r, [
      {
        method: 'recover-control',
        params: { recoveryId: id, selectedCandidateIds: [candidates[0].id] },
      },
    ]);
    assert.equal(r.request.execution.mode, 'operating', show(r.request));
    assert.equal(await frames(tab), 0);
    r = await act(r, [{ method: 'click', params: { ref: ref(r, 'Count action') } }]);
    assert.equal(await count(tab), '1');
    await client.ask({ type: 'remote-stop' });
    await eventually(async () => !(await client.state()).loopActive);
  };

  // 1. The foreign UI frame is already embedded: Chrome refuses the attach itself.
  await scenario('a refused first attach becomes a recoverable suspension', async () => {
    const eager = await open('?eager');
    assert.equal(await frames(eager), 1);
    let r = await begin(eager, 'Use the page with a foreign UI frame');
    r = await act(r, [
      { method: 'use-current-tab', params: { contextId: r.request.context.pages[0].contextId } },
    ]);
    console.log('after use-current-tab:', show(r.request?.execution));
    assert.equal(r.request?.execution?.mode, 'recovery', show(r.request?.execution));
    assert.equal(await frames(eager), 1, 'nothing is removed before an explicit selection');
    await removeAndOperate(r, eager);
  });

  // 2. Control is live, then the foreign UI appears: Chrome detaches (target_closed).
  // Needs the stand-in's deferred injection; a real extension may embed at load.
  if (!globalThis.process.env.FOREIGN_EXTENSION_DIR)
    await scenario(
      'a refused reattachment stays recoverable through explicit removal',
      async () => {
        const lazy = await open('?lazy');
        assert.equal(await frames(lazy), 0);
        let r = await begin(lazy, 'Operate the page, then the foreign UI appears');
        r = await act(r, [
          {
            method: 'use-current-tab',
            params: { contextId: r.request.context.pages[0].contextId },
          },
        ]);
        r = await act(r, [{ method: 'click', params: { ref: ref(r, 'Summon foreign UI') } }]);
        assert.equal(r.request?.execution?.mode, 'recovery', show(r.request));
        assert.equal(await frames(lazy), 1);
        const firstId = r.request.execution.recovery.recoveryId;
        // Reattach without removal: Chrome refuses while the frame remains.
        r = await act(r, [{ method: 'recover-control', params: { recoveryId: firstId } }]);
        console.log('after unselected recover-control:', show(r.result));
        assert.equal(r.request?.execution?.mode, 'recovery', 'the task stays recoverable');
        assert.notEqual(r.request.execution.recovery.recoveryId, firstId);
        assert.equal(await frames(lazy), 1, 'nothing was removed without selection');
        await removeAndOperate(r, lazy);
      },
    );
  assert.deepEqual(failures, []);
} finally {
  for (const client of clients) await close(client);
  relay?.close();
  site?.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
