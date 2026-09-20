// Two disposable Chrome installations against the real Remote. No real Agent,
// personal profiles or external sites; decisions are deterministic fixtures.
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
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'coco-instances-e2e-'));
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
  const extension = path.join(root, '.output/chrome-mv3');
  const process = spawn(
    chromePath,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-extensions-except=' + extension,
      '--load-extension=' + extension,
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
    const name = req.url === '/A' ? 'A' : 'B';
    res.setHeader('Content-Type', 'text/html');
    res.end(
      `<!doctype html><title>Browser ${name}</title><h1>Browser ${name}</h1><button id="action" onclick="this.dataset.count=String(Number(this.dataset.count)+1)" data-count="0">Action ${name}</button>`,
    );
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  relay = await start({
    extPort: 0,
    agentPort: 0,
    monitor: true,
    onRequest: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });
  const a = await launch('A'),
    b = await launch('B');
  const sa = await a.state(),
    sb = await b.state();
  assert.equal(sa.keyId, sb.keyId);
  assert.notEqual(sa.browserId, sb.browserId);
  assert.notEqual(sa.endpointId, sb.endpointId);
  assert.equal(relay.ext.connectedIds().length, 2);
  const createPage = (client, name) =>
    client.evaluate(
      `chrome.tabs.create({url:${JSON.stringify(`http://127.0.0.1:${site.address().port}/${name}`)},active:true})`,
    );
  const ta = await createPage(a, 'A'),
    tb = await createPage(b, 'B');
  for (const [client, tab] of [
    [a, ta],
    [b, tb],
  ])
    await eventually(() =>
      client.evaluate(`chrome.tabs.get(${tab.id}).then(t=>t.status==='complete')`),
    );
  const begin = async (client, tab, text) => {
    await client.ask({ type: 'remote-chat-send', tabId: tab.id, windowId: tab.windowId, text });
    return eventually(() => messages.find((message) => message.text === text));
  };
  let ra = await begin(a, ta, 'Operate browser A'),
    rb = await begin(b, tb, 'Operate browser B');
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
    return { endpointId: result.next.endpointId, request: result.next };
  };
  ra = await act(ra, [
    { method: 'use-current-tab', params: { contextId: ra.request.payload.initialPage.contextId } },
  ]);
  const ref = (request, text) =>
    request.request.payload.observation.page.text
      .split('\n')
      .find((line) => line.includes(JSON.stringify(text)))
      ?.match(/@[^\s]+/)?.[0];
  ra = await act(ra, [{ method: 'click', params: { ref: ref(ra, 'Action A') } }]);
  const count = (client, tab) =>
    client.evaluate(
      `chrome.scripting.executeScript({target:{tabId:${tab.id}},func:()=>document.querySelector('#action').dataset.count}).then(r=>r[0].result)`,
    );
  assert.equal(await count(a, ta), '1');
  assert.equal(await count(b, tb), '0');
  assert.equal(
    (await post(sb.endpointId, ra.request.id, { kind: 'done', text: 'Wrong browser' })).code,
    'STALE_DECISION',
  );
  assert.ok(!(await b.state()).chat.some((m) => m.text === 'Wrong browser'));
  await a.ask({ type: 'remote-stop' });
  assert.equal((await a.state()).loopActive, false);
  assert.equal((await b.state()).loopActive, true);
  rb = await act(rb, [
    { method: 'use-current-tab', params: { contextId: rb.request.payload.initialPage.contextId } },
  ]);
  rb = await act(rb, [{ method: 'click', params: { ref: ref(rb, 'Action B') } }]);
  assert.equal(await count(a, ta), '1');
  assert.equal(await count(b, tb), '1');
  await a.ask({ type: 'remote-set-enabled', enabled: false });
  await a.ask({ type: 'remote-set-enabled', enabled: true });
  await eventually(async () => (await a.state()).connected);
  assert.equal((await a.state()).endpointId, sa.endpointId);
  assert.equal((await b.state()).loopActive, true);
  assert.equal(
    (await post(sa.endpointId, ra.request.id, { kind: 'done', text: 'Late A' })).code,
    'STALE_DECISION',
  );
  assert.equal(
    (await post(rb.endpointId, rb.request.id, { kind: 'done', text: 'Only browser B' })).finished,
    true,
  );
  assert.ok((await b.state()).chat.some((m) => m.text === 'Only browser B'));
  assert.ok(!(await a.state()).chat.some((m) => m.text === 'Only browser B'));
  await close(a);
  const restarted = await launch('A');
  assert.equal((await restarted.state()).browserId, sa.browserId);
  assert.equal((await restarted.state()).endpointId, sa.endpointId);
  assert.equal((await b.state()).connected, true);
  assert.equal(relay.ext.connectedIds().length, 2);
  console.log(
    'PASS two real Chrome profiles share one key: independent page actions, replies, stop, reconnect and persistent identity',
  );
} finally {
  for (const client of clients) await close(client);
  relay?.close();
  site?.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
