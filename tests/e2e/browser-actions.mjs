// Run against a disposable Chrome profile and the actual sibling thin relay.
// No user profile, external websites, live Agent queue, or installed browser state.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const chromePath =
  process.env.CHROME_PATH ||
  path.join(
    os.homedir(),
    'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  );
const require = createRequire(import.meta.url);
const relayRoot = process.env.RELAY_ROOT || path.resolve(root, '../zylos-browser-remote');
process.env.BROWSER_REMOTE_KEY = 'ab'.repeat(32);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'coco-actions-e2e-'));
process.env.BROWSER_REMOTE_OBS_DIR = path.join(profile, 'observations');
const { start } = require(path.join(relayRoot, 'src/index.js'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const measurements = [];
const chatMessages = [];
let browser, relay, socket, site;
async function eventually(work, timeout = 10000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      const value = await work();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  throw last || new Error('Condition did not match');
}
function cdpClient(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data)),
      p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  });
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => {
        pending.delete(n);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      pending.set(n, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: n, method, params, sessionId }));
    });
}
function fixture(url, port) {
  if (url.startsWith('/article'))
    return `<!doctype html><title>Read-only article</title><h1>Article heading</h1>
    <button onclick="this.textContent='Action confirmed'">Article action</button>
    <a href="/next">Real source</a><input value="PRIVATE_FIELD"><div contenteditable>PRIVATE_DRAFT</div>
    <p hidden>PRIVATE_HIDDEN</p><p>${'Loaded article sentence. '.repeat(1000)}</p><h2>Article ending</h2>
    <div id="shadow"></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<p>Open shadow article</p>'</script>`;
  if (url.startsWith('/loop'))
    return `<!doctype html><title>Browser loop fixture</title>
    <form action="/next" target="_blank"><input name="q" aria-label="Popup query"></form>
    <form action="/next"><input name="q" aria-label="Same tab query"></form>
    <button onclick="this.textContent='Clicked '+(++window.clicks)">Count click</button>
    <div style="height:5000px">Scroll for more results</div><h2>Bottom results</h2>
    <script>window.clicks=0;addEventListener('scroll',()=>{if(!document.querySelector('#lazy')&&scrollY>100){const e=document.createElement('p');e.id='lazy';e.textContent='Lazy result loaded';document.body.append(e)}})</script>`;
  if (url.startsWith('/media'))
    return `<!doctype html><title>Native media playback fixture</title>
    <video id="player" muted playsinline width="320" height="180"></video>
    <button id="play-toggle" aria-label="Play" title="Play" data-clicks="0">Toggle</button>
    <script>
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
    const ctx=canvas.getContext('2d');let frame=0;
    setInterval(()=>{ctx.fillStyle=frame++%2?'#7856bb':'#37a177';ctx.fillRect(0,0,320,180);ctx.fillStyle='white';ctx.fillText(String(frame),30,30)},50);
    const player=document.querySelector('#player'),toggle=document.querySelector('#play-toggle');
    player.srcObject=canvas.captureStream(20);
    toggle.onclick=async()=>{toggle.dataset.clicks=String(+toggle.dataset.clicks+1);if(player.paused)await player.play();else player.pause()};
    for(const event of ['play','pause'])player.addEventListener(event,()=>{toggle.ariaLabel=toggle.title=player.paused?'Play':'Pause'});
    </script>`;
  if (url.startsWith('/preview'))
    return `<!doctype html><title>Research board · Live preview</title>
    <style>body{margin:0;padding:48px;font:20px system-ui;background:#f6f3fa;color:#2c2033}header{font-size:18px;color:#8064a1}h1{font-size:42px;margin:28px 0 8px}.cards{display:flex;gap:24px;margin-top:36px}.card{padding:28px;background:white;border-radius:20px;flex:1;box-shadow:0 8px 24px #29113608}.bar{height:12px;border-radius:8px;background:#b997eb;margin-top:20px;transform-origin:left;animation:progress 2s infinite alternate ease-in-out}@keyframes progress{from{transform:scaleX(.1)}to{transform:scaleX(1)}}.tag{font-size:14px;color:#826996}</style>
    <header>COCO / WORKSPACE</header><h1>Research board</h1><p>Organizing your browser findings</p>
    <div class="cards"><div class="card"><span class="tag">READING</span><h2>Product overview</h2><p>Reviewing the current page</p><div class="bar"></div></div><div class="card"><span class="tag">COMPARING</span><h2>Key features</h2><p>Collecting useful details</p><div class="bar" style="animation-delay:-1s"></div></div></div>`;
  if (url.startsWith('/far-frame'))
    return `<!doctype html><title>Offscreen iframe</title><input type="password" value="fixture-password" aria-label="Password"><input id="otp" autocomplete="one-time-code" value="987654" aria-label="One-time code"><div style="height:2400px">Top</div><iframe style="width:450px;height:250px" src="http://localhost:${port}/frame"></iframe>`;
  if (url.startsWith('/nested'))
    return `<!doctype html><title>Nested parent</title><iframe style="width:390px;height:150px" src="http://localhost:${port}/frame"></iframe>`;
  if (url.startsWith('/frame'))
    return `<!doctype html><title>Frame</title><style>body{margin:20px}button,input{margin:10px}</style><button id="frame-button" onclick="this.textContent='Frame clicked'">Frame button</button><input id="frame-input" aria-label="Frame input"><div id="shadow"></div><script>const s=document.querySelector('#shadow').attachShadow({mode:'open'});s.innerHTML='<input id="shadow-input" aria-label="Shadow input"><button id="shadow-button">Shadow button</button>';s.querySelector('button').onclick=()=>s.querySelector('button').textContent='Shadow clicked';</script>`;
  if (url.startsWith('/popup'))
    return '<!doctype html><title>Popup</title><button id="popup-button" onclick="this.textContent=\'Popup clicked\'">Popup action</button>';
  if (url.startsWith('/next'))
    return '<!doctype html><title>Next page</title><h1 id="next">Next page</h1>';
  return `<!doctype html><title>Browser actions fixture</title><style>
body{font:16px sans-serif;margin:20px}button,input,select{margin:5px;padding:8px}#hover-menu{display:none}#hover:hover #hover-menu{display:block}#hover{width:160px;padding:10px;background:#ddd}#panel{height:90px;width:200px;overflow:auto;border:1px solid}#panel div{height:900px}#canvas{position:fixed;left:1100px;top:20px;width:100px;height:60px;background:#eee;z-index:10}#slider{position:fixed;left:1000px;top:100px;width:220px;height:50px;background:#ccc;z-index:10}#drag,#drop{display:inline-block;width:110px;height:50px;background:#ccc;margin:10px}iframe{width:450px;height:160px;display:block;margin-top:10px}
</style>
<button id="click" onclick="this.dataset.count=+(this.dataset.count||0)+1;this.textContent='Clicked '+this.dataset.count">Click</button>
<button id="double" ondblclick="this.textContent='Double clicked'">Double</button>
<button id="right" oncontextmenu="event.preventDefault();this.textContent='Right clicked'">Right</button>
<div id="hover">Hover here<button id="hover-menu">Menu item</button></div>
<input id="input" aria-label="Text input"><input id="check" type="checkbox" aria-label="Checkbox"><select id="select" aria-label="Select"><option value="a">Alpha</option><option value="b">Beta</option></select>
<div id="panel" tabindex="0"><div>Scrollable content</div></div>
<div id="drag" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','fixture')">Drag source</div><div id="drop" ondragover="event.preventDefault()" ondrop="event.preventDefault();this.textContent='Dropped '+event.dataTransfer.getData('text/plain')">Drop target</div>
<div id="slider" onpointerdown="this.setPointerCapture(event.pointerId)" onpointermove="if(event.buttons)this.textContent=String(Math.round(event.clientX))">Slider</div><canvas id="canvas" width="100" height="60" onclick="document.querySelector('#canvas-result').textContent='Canvas clicked'"></canvas><span id="canvas-result"></span>
<button id="dialog" onclick="document.querySelector('#dialog-result').textContent=confirm('Fixture confirm?')?'Accepted':'Dismissed'">Confirm</button><span id="dialog-result"></span>
<button id="prompt" onclick="document.querySelector('#dialog-result').textContent=prompt('Fixture prompt?','default')">Prompt</button>
<button id="schedule" onclick="setTimeout(()=>{let b=document.createElement('button');b.id='late';b.textContent='Ready';document.body.append(b)},300)">Schedule</button>
<button id="delayed-next" onclick="setTimeout(()=>location.href='/next',450)">Delayed navigation</button>
<a id="redirect-next" href="/redirect">Redirect navigation</a>
<button id="same-url-reload" onclick="sessionStorage.setItem('reload-proof','yes');location.reload()">Reload same URL</button>
<button id="frame-only" onclick="document.querySelector('iframe').src='/frame?changed=1'">Frame navigation only</button>
<button id="delayed-blocked" onclick="setTimeout(()=>location.href='/checkout',450)">Blocked destination</button>
<form action="/next"><input id="submit-input" name="q" aria-label="Submit query"></form>
<a id="popup" href="/popup" target="_blank">Open popup</a><a id="next" href="/next">Next</a>
<a id="spa" href="/spa" onclick="event.preventDefault();history.pushState({},'',this.href);this.textContent='SPA opened'">Open SPA</a>
<iframe title="Same origin" src="/frame"></iframe><iframe title="Cross origin" src="http://localhost:${port}/frame"></iframe>
<iframe title="Nested scaled" style="transform:scale(.9);transform-origin:top left;height:200px" src="/nested"></iframe><div id="shadow"></div><div id="closed"></div><script>const closed=document.querySelector('#closed').attachShadow({mode:'closed'});closed.innerHTML='<button>Closed shadow button</button>';closed.querySelector('button').onclick=()=>closed.querySelector('button').textContent='Closed shadow clicked';const r=document.querySelector('#shadow').attachShadow({mode:'open'});r.innerHTML='<input id="root-shadow-input" aria-label="Root shadow input"><button id="root-shadow-button">Root shadow button</button>';r.querySelector('button').onclick=()=>r.querySelector('button').textContent='Root shadow clicked';</script>`;
}
try {
  site = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/next?actual=redirected' });
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(fixture(req.url, site.address().port));
  });
  await new Promise((resolve) => site.listen(0, resolve));
  const url = `http://127.0.0.1:${site.address().port}/`;
  relay = await start({
    extPort: 0,
    agentPort: 0,
    monitor: true,
    monitorFile: path.join(profile, 'monitor.json'),
    agentMonitorDir: null,
    onRequest: async (message) => {
      chatMessages.push(message);
      if (message.text === 'fixture:fail-delivery')
        return { ok: false, code: 'C4_DELIVERY_FAILED' };
      return { ok: true };
    },
  });
  const rpcUrl = `http://127.0.0.1:${relay.agent.server.address().port}`;
  const relayUrl = `ws://127.0.0.1:${relay.ext.server.address().port}/ext`;
  const extension = path.join(root, '.output/chrome-mv3');
  browser = spawn(
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
      '--window-size=1280,1400',
      '--site-per-process',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  browser.stderr.on('data', (d) => {
    stderr += d;
  });
  const devtools = await eventually(async () => {
    const value = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'))
      .trim()
      .split('\n');
    return `ws://127.0.0.1:${value[0]}${value[1]}`;
  });
  socket = new WebSocket(devtools);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const cdp = cdpClient(socket);
  const worker = await eventually(async () =>
    (await cdp('Target.getTargets')).targetInfos.find(
      (t) =>
        t.type === 'service_worker' &&
        t.url.startsWith('chrome-extension://') &&
        t.url.endsWith('/background.js'),
    ),
  );
  const extensionId = new URL(worker.url).host;
  const { targetId } = await cdp('Target.createTarget', {
    url: `chrome-extension://${extensionId}/sidepanel.html`,
  });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await eventually(
    async () =>
      (
        await cdp(
          'Runtime.evaluate',
          { expression: '!!globalThis.chrome?.runtime?.sendMessage', returnByValue: true },
          sessionId,
        )
      ).result.value,
  );
  // Configure through the real settings form, including native React input events.
  await eventually(
    async () =>
      (
        await cdp(
          'Runtime.evaluate',
          {
            expression: "!!document.querySelector('#relay-url')",
            returnByValue: true,
          },
          sessionId,
        )
      ).result.value,
  );
  for (const [selector, value] of [
    ['#relay-url', relayUrl],
    ['#access-key', process.env.BROWSER_REMOTE_KEY],
  ]) {
    await cdp(
      'Runtime.evaluate',
      {
        expression: `document.querySelector(${JSON.stringify(selector)}).focus(); document.querySelector(${JSON.stringify(selector)}).select();`,
      },
      sessionId,
    );
    await cdp('Input.insertText', { text: value }, sessionId);
  }
  await cdp(
    'Runtime.evaluate',
    { expression: "document.querySelector('.save-button').click()" },
    sessionId,
  );
  const behavior = await cdp(
    'Runtime.evaluate',
    {
      expression: 'chrome.sidePanel.getPanelBehavior()',
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  );
  assert.equal(
    behavior.result.value.openPanelOnActionClick,
    true,
    'toolbar action opens the sidebar',
  );
  const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');

  await eventually(
    async () =>
      Object.keys((await (await fetch(rpcUrl + '/status')).json()).extensions || {}).length,
  );
  const check = async (name, work) => {
    if (process.env.E2E_FILTER && !name.includes(process.env.E2E_FILTER)) return;
    await work();
    checks.push(name);
    console.log('PASS', name);
  };
  // The test loads sidepanel.html in a tab. Keep it visible like the real side panel
  // while browser commands focus other tabs. Images still come from real Chrome CDP.
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
  const previewPanel = async (expression) => {
    const result = await cdp(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  // Observe calls made by the extension itself; the test driver's separate CDP
  // connection to the disposable worker is not a browser-control attachment.
  const { sessionId: workerSession } = await cdp('Target.attachToTarget', {
    targetId: worker.targetId,
    flatten: true,
  });
  const workerEval = async (expression) => {
    const value = await cdp(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      workerSession,
    );
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
    return value.result.value;
  };
  await workerEval(`globalThis.debuggerCalls = []; for (const name of ['attach','detach','sendCommand']) {
    const original = chrome.debugger[name];
    chrome.debugger[name] = function(...args) { debuggerCalls.push(name === 'sendCommand' ? args[1] : name); return original.apply(chrome.debugger, args); };
  }`);
  const panelState = async () =>
    (await previewPanel("chrome.runtime.sendMessage({type:'remote-state'})")).value;
  await eventually(async () => (await panelState()).connected);
  const askLoop = async (text, tab) => {
    const reply = await previewPanel(
      `chrome.runtime.sendMessage(${JSON.stringify({ type: 'remote-chat-send', text, ...(tab ? { tabId: tab.id, windowId: tab.windowId } : {}) })})`,
    );
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return eventually(() =>
      chatMessages.find((message) => message.text === text && message.request),
    );
  };
  const decision = async (request, value) => {
    const response = await fetch(rpcUrl + '/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: request.request.id, decision: value }),
    });
    const body = await response.json();
    if (!body.ok)
      throw Object.assign(new Error(`${body.code}: ${body.message}`), { code: body.code });
    if (body.next && !chatMessages.some((message) => message.request?.id === body.next.id))
      chatMessages.push({
        text: body.next.text,
        chatId: body.next.taskId,
        request: { id: body.next.id, round: body.next.round, payload: body.next.payload },
      });
    return { replayed: false, ...body };
  };
  const nextRound = (request) =>
    eventually(
      () =>
        chatMessages.find(
          (message) =>
            message.chatId === request.chatId &&
            message.request?.round === request.request.round + 1,
        ),
      18000,
    );
  const refIn = (request, label) => {
    const line = request.request.payload.observation.page.text
      .split('\n')
      .find((line) => line.includes(JSON.stringify(label)));
    assert.ok(line, `Missing ref ${label}: ${JSON.stringify(request.request.payload.observation)}`);
    return line.split(' ')[0];
  };
  const finishLoop = async (request, text) => {
    // Exercise the standard channel adapter with a real Chrome extension.
    // When Core is available, also exercise its real sender and isolated SQLite.
    const coreSend =
      process.env.ZYLOS_C4_SEND ||
      path.resolve(root, '../zylos-core/skills/comm-bridge/scripts/c4-send.js');
    const hasCore = await fs.access(coreSend).then(
      () => true,
      () => false,
    );
    const isolatedZylos = path.join(profile, 'zylos');
    const skills = path.join(isolatedZylos, '.claude/skills');
    await fs.mkdir(skills, { recursive: true });
    try {
      await fs.symlink(relayRoot, path.join(skills, 'browser-remote'));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const endpoint = `${relay.ext.connectedIds()[0]}|req:${request.request.id}|status:done`;
    const send = () =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          hasCore
            ? [coreSend, 'browser-remote', endpoint]
            : [path.join(relayRoot, 'scripts/send.js'), endpoint, text],
          {
            env: { ...process.env, BROWSER_REMOTE_AGENT_URL: rpcUrl, ZYLOS_DIR: isolatedZylos },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        let output = '';
        child.stdout.on('data', (chunk) => (output += chunk));
        child.stderr.on('data', (chunk) => (output += chunk));
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0) return reject(new Error(output));
          try {
            const result = JSON.parse(output.split('\n').find((line) => line.startsWith('{"ok":')));
            assert.equal(result.finished, true);
            assert.equal(result.status, 'done');
            resolve(result);
          } catch (error) {
            reject(error);
          }
        });
        child.stdin.end(hasCore ? text : '');
      });
    await send();
    assert.equal((await send()).replayed, true, 'final reply retry reuses the completion receipt');
    await eventually(
      async () =>
        !(await previewPanel("chrome.runtime.sendMessage({type:'remote-state'})")).value.loopActive,
    );
    assert.equal((await panelState()).task, null);
  };
  await check(
    'chat and paginated DOM reads stay CDP-free; late control keeps the captured tab',
    async () => {
      const tab = await previewPanel(
        `chrome.tabs.create({url:${JSON.stringify(url + 'article')},active:true})`,
      );
      await eventually(
        async () => (await previewPanel(`chrome.tabs.get(${tab.id})`)).status === 'complete',
      );
      await workerEval('debuggerCalls.length = 0');
      let started = performance.now();
      let request = await askLoop('Article: just say hello', tab);
      const initial = request.request.payload.initialPage;
      measurements.push({
        operation: 'message context (DOM)',
        elapsedMs: Math.round(performance.now() - started),
        outputBytes: Buffer.byteLength(JSON.stringify(initial)),
        debuggerCalls: (await workerEval('debuggerCalls')).length,
      });
      assert.equal(request.request.payload.mode, 'reading');
      assert.ok(initial.text.includes('Article heading'));
      assert.ok(!JSON.stringify(initial).includes('PRIVATE_'));
      assert.ok(initial.nextOffset > 0);
      assert.equal((await panelState()).task, null);
      await finishLoop(request, 'Hello');
      assert.deepEqual(await workerEval('debuggerCalls'), []);

      request = await askLoop('Article: summarize then perform the requested action', tab);
      const context = request.request.payload.initialPage;
      const other = await previewPanel(
        `chrome.tabs.create({url:${JSON.stringify(url + 'next')},active:true})`,
      );
      let cursor = context.nextOffset,
        text = context.text;
      for (let chunk = 0; cursor !== null; chunk++) {
        assert.ok(chunk < 5, 'bounded article pagination');
        started = performance.now();
        await decision(request, {
          kind: 'actions',
          actions: [
            {
              method: 'read-page',
              params: {
                contextId: context.contextId,
                offset: cursor,
                contentVersion: context.contentVersion,
              },
            },
          ],
        });
        request = await nextRound(request);
        const page = request.request.payload.observation.page;
        assert.equal(
          request.request.payload.failed,
          false,
          JSON.stringify(request.request.payload),
        );
        assert.equal(request.request.payload.mode, 'reading');
        assert.equal(
          request.request.payload.tools,
          undefined,
          'read rounds do not unlock action schemas',
        );
        assert.equal(page.url, url + 'article');
        text += page.text;
        cursor = page.nextOffset;
        measurements.push({
          operation: 'read-page',
          elapsedMs: Math.round(performance.now() - started),
          outputBytes: Buffer.byteLength(JSON.stringify(page)),
          debuggerCalls: (await workerEval('debuggerCalls')).length,
        });
      }
      assert.ok(text.includes('Article ending') && text.includes('Open shadow article'));
      assert.deepEqual(await workerEval('debuggerCalls'), []);
      assert.equal((await panelState()).task, null);
      await assert.rejects(
        decision(request, {
          kind: 'actions',
          actions: [{ method: 'click', params: { ref: '@invented' } }],
        }),
        (error) => error.code === 'BAD_DECISION',
      );
      await decision(request, {
        kind: 'actions',
        actions: [{ method: 'use-current-tab', params: { contextId: context.contextId } }],
      });
      request = await nextRound(request);
      assert.equal(request.request.payload.mode, 'operating');
      assert.ok(request.request.payload.tools.some((tool) => tool.name === 'click'));
      assert.equal(request.request.payload.observation.target.id, tab.id);
      assert.ok((await workerEval('debuggerCalls')).includes('attach'));
      await decision(request, {
        kind: 'actions',
        actions: [{ method: 'click', params: { ref: refIn(request, 'Article action') } }],
      });
      request = await nextRound(request);
      assert.ok(request.request.payload.observation.page.text.includes('Action confirmed'));
      await finishLoop(request, 'Article summarized and requested action confirmed');
      await previewPanel(`chrome.tabs.remove([${tab.id},${other.id}])`);
    },
  );
  await check(
    'same-URL reload invalidates read and control contexts before debugger attachment',
    async () => {
      const tab = await previewPanel(
        `chrome.tabs.create({url:${JSON.stringify(url + 'article')},active:true})`,
      );
      await eventually(
        async () => (await previewPanel(`chrome.tabs.get(${tab.id})`)).status === 'complete',
      );
      let request = await askLoop('Article: stale document', tab);
      const contextId = request.request.payload.initialPage.contextId;
      const before = await previewPanel(
        `chrome.webNavigation.getFrame({tabId:${tab.id},frameId:0})`,
      );
      await previewPanel(`chrome.tabs.reload(${tab.id})`);
      await eventually(
        async () =>
          (await previewPanel(`chrome.webNavigation.getFrame({tabId:${tab.id},frameId:0})`))
            ?.documentId !== before.documentId &&
          (await previewPanel(`chrome.tabs.get(${tab.id})`)).status === 'complete',
      );
      await workerEval('debuggerCalls.length = 0');
      for (const method of ['read-page', 'use-current-tab']) {
        await decision(request, { kind: 'actions', actions: [{ method, params: { contextId } }] });
        request = await nextRound(request);
        assert.equal(request.request.payload.mode, 'reading');
        assert.ok(
          request.request.payload.results.some((result) => result.error?.code === 'PAGE_CHANGED'),
        );
      }
      assert.deepEqual(await workerEval('debuggerCalls'), []);
      await finishLoop(request, 'The captured page reloaded; send a new message');
      await previewPanel(`chrome.tabs.remove(${tab.id})`);
    },
  );
  await check(
    'live preview streams real background-tab frames, stays anchored, and freezes on completion',
    async () => {
      let request = await askLoop('Preview the research board');
      const action = async (method, params = {}) => {
        await decision(request, { kind: 'actions', actions: [{ method, params }] });
        request = await nextRound(request);
      };
      await action('open', { url: url + 'preview' });
      const tab = (await panelState()).task.tabId;
      await eventually(() =>
        previewPanel("document.querySelector('.live-preview-image')?.naturalWidth > 0"),
      );
      const first = await previewPanel(
        "Number(document.querySelector('.live-preview').dataset.frameSequence)",
      );
      await eventually(
        async () =>
          (await previewPanel(
            "Number(document.querySelector('.live-preview').dataset.frameSequence)",
          )) >
          first + 2,
      );
      const other = await previewPanel(
        `chrome.tabs.create({url:${JSON.stringify(url + 'next')},active:true})`,
      );
      const second = await previewPanel(
        "Number(document.querySelector('.live-preview').dataset.frameSequence)",
      );
      await eventually(
        async () =>
          (await previewPanel(
            "Number(document.querySelector('.live-preview').dataset.frameSequence)",
          )) >
          second + 2,
      );
      assert.equal(
        await previewPanel("Number(document.querySelector('.live-preview').dataset.tabId)"),
        tab,
      );
      assert.equal(
        (await previewPanel(`chrome.tabs.get(${other.id})`)).active,
        true,
        'streaming does not steal focus',
      );
      const save = async (name) => {
        if (!process.env.E2E_SCREENSHOT_DIR) return;
        await fs.mkdir(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
        const shot = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
        await fs.writeFile(
          path.join(process.env.E2E_SCREENSHOT_DIR, name + '.png'),
          Buffer.from(shot.data, 'base64'),
        );
      };
      for (const width of [380, 320]) {
        await cdp(
          'Emulation.setDeviceMetricsOverride',
          { width, height: 820, deviceScaleFactor: 1, mobile: false },
          sessionId,
        );
        await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 }, sessionId);
        await sleep(160);
        const layout = await previewPanel(`(() => {
        const card=document.querySelector('.live-preview').getBoundingClientRect();
        const field=document.querySelector('.composer-field').getBoundingClientRect();
        return { width:card.width,height:card.height,right:card.right,fieldRight:field.right,gap:field.top-card.bottom,
          x:card.x+card.width/2,y:card.y+50,opacity:getComputedStyle(document.querySelector('.live-preview-actions')).opacity,
          overflow:document.documentElement.scrollWidth>innerWidth };
      })()`);
        assert.equal(layout.width, 240);
        assert.ok(Math.abs(layout.height - 166) < 1);
        assert.ok(Math.abs(layout.right - layout.fieldRight) < 2);
        assert.ok(Math.abs(layout.gap - 8) < 2);
        assert.equal(layout.overflow, false);
        assert.equal(layout.opacity, '0');
        await save('live-preview-default-' + width);
        await cdp(
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x: layout.x, y: layout.y },
          sessionId,
        );
        await eventually(
          async () =>
            (await previewPanel(
              "getComputedStyle(document.querySelector('.live-preview-actions')).opacity",
            )) === '1',
        );
        await save('live-preview-hover-' + width);
        await previewPanel("document.querySelector('.live-preview').focus()");
        await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 }, sessionId);
        assert.equal(
          await previewPanel(
            "getComputedStyle(document.querySelector('.live-preview-actions')).opacity",
          ),
          '1',
        );
        await previewPanel('document.activeElement.blur()');
      }
      const controlledSession = (await panelState()).task.sessionId;
      await previewPanel("document.querySelector('.preview-close').click()");
      await eventually(() => previewPanel("!document.querySelector('.live-preview')"));
      assert.equal(await previewPanel("!!document.querySelector('.preview-restore')"), true);
      assert.equal(await previewPanel("!!document.querySelector('#stop-task')"), true);
      assert.equal((await panelState()).task.sessionId, controlledSession);
      await save('live-preview-closed-320');
      await action('new-tab', { url: url + 'preview?second' });
      const secondTab = (await panelState()).task.tabId;
      assert.notEqual(secondTab, tab);
      assert.equal(await previewPanel("!!document.querySelector('.live-preview')"), false);
      await previewPanel("document.querySelector('.preview-restore').click()");
      await eventually(() =>
        previewPanel(
          `Number(document.querySelector('.live-preview')?.dataset.tabId) === ${secondTab} && document.querySelector('.live-preview-image')?.naturalWidth > 0`,
        ),
      );
      await action('switch-tab', { tabId: tab });
      await eventually(() =>
        previewPanel(
          `Number(document.querySelector('.live-preview')?.dataset.tabId) === ${tab} && document.querySelector('.live-preview-image')?.naturalWidth > 0`,
        ),
      );
      await finishLoop(request, 'Preview fixture complete');
      await eventually(
        async () =>
          (await previewPanel("document.querySelector('.live-preview').dataset.status")) ===
          'completed',
      );
      assert.equal(await previewPanel("!!document.querySelector('.live-preview-completed')"), true);
      assert.equal(await previewPanel("!!document.querySelector('#stop-task')"), false);
      await sleep(200);
      const frozen = await previewPanel(
        "document.querySelector('.live-preview').dataset.frameSequence",
      );
      await sleep(400);
      assert.equal(
        await previewPanel("document.querySelector('.live-preview').dataset.frameSequence"),
        frozen,
      );
      await save('live-preview-completed-320');
      await previewPanel("document.querySelector('.preview-view').click()");
      await eventually(async () => (await previewPanel(`chrome.tabs.get(${tab})`)).active);
      assert.equal(
        await previewPanel("document.querySelector('.live-preview').dataset.status"),
        'completed',
      );
      await previewPanel(`chrome.tabs.remove([${tab},${other.id},${secondTab}])`);
      await eventually(() => previewPanel("document.querySelector('.preview-view').disabled"));
      await previewPanel("chrome.runtime.sendMessage({type:'remote-chat-clear'})");
      await eventually(() => previewPanel("!document.querySelector('.live-preview')"));
    },
  );
  await check(
    'extension loop answers ordinary chat without opening or controlling tabs',
    async () => {
      const before = (await previewPanel('chrome.tabs.query({})')).map((tab) => tab.id);
      const request = await askLoop('Loop: just say hello');
      assert.equal(request.request.payload.protocol, 'browser-decision-v1');
      assert.equal(
        request.request.payload.tools.length,
        3,
        'ordinary chat does not receive the entire browser catalog',
      );
      await finishLoop(request, 'Hello from structured decision');
      assert.deepEqual(
        (await previewPanel('chrome.tabs.query({})')).map((tab) => tab.id),
        before,
      );
    },
  );
  await check(
    'extension loop validates before input, batches fill+Enter and follows its actual popup',
    async () => {
      const tab = await previewPanel(
        `chrome.tabs.create({url:${JSON.stringify(url + 'loop')},active:true})`,
      );
      await eventually(
        async () => (await previewPanel(`chrome.tabs.get(${tab.id})`)).status === 'complete',
      );
      let request = await askLoop('Loop: search in the captured page', tab);
      const initial = request;
      await decision(request, {
        kind: 'actions',
        actions: [
          {
            method: 'use-current-tab',
            params: { contextId: request.request.payload.initialPage.contextId },
          },
        ],
      });
      request = await nextRound(request);
      assert.equal(request.request.payload.observation.target.id, tab.id);
      const ref = refIn(request, 'Popup query');
      await assert.rejects(
        decision(request, {
          kind: 'actions',
          actions: [
            { method: 'fill', params: { ref, text: 'MUST NOT RUN' } },
            { method: 'click', params: {} },
          ],
        }),
        (error) => error.code === 'BAD_DECISION',
      );
      for (const route of ['/rpc', '/chat']) {
        assert.equal(
          (
            await fetch(rpcUrl + route, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            })
          ).status,
          404,
        );
      }
      const unrelated = await previewPanel(
        `chrome.tabs.create({url:${JSON.stringify(url + 'next?personal=1')},active:true})`,
      );
      const value = {
        kind: 'actions',
        memory: 'Need actual search results',
        actions: [
          { method: 'fill', params: { ref, text: 'spider' } },
          { method: 'keypress', params: { key: 'Enter', ref } },
        ],
      };
      const receipt = await decision(request, value);
      assert.equal(receipt.replayed, false);
      assert.equal((await decision(request, value)).replayed, true);
      const previous = request;
      request = await nextRound(request);
      assert.equal(request.request.payload.failed, false, JSON.stringify(request.request.payload));
      assert.ok(
        request.request.payload.observation.target.url.includes('/next?q=spider'),
        JSON.stringify({
          payload: request.request.payload,
          tabs: await previewPanel('chrome.tabs.query({})'),
        }),
      );
      assert.notEqual(request.request.payload.observation.target.id, tab.id);
      assert.notEqual(request.request.payload.observation.target.id, unrelated.id);
      assert.equal((await previewPanel(`chrome.tabs.get(${tab.id})`)).url, url + 'loop');
      const opened = (await previewPanel('chrome.tabs.query({})')).filter((t) =>
        t.url.includes('/next?q=spider'),
      );
      assert.equal(opened.length, 1, 'duplicate decisions never submit twice');
      await finishLoop(request, 'Popup search completed');
      assert.equal((await decision(previous, value)).replayed, true);
      assert.equal(
        (await previewPanel('chrome.tabs.query({})')).filter((t) =>
          t.url.includes('/next?q=spider'),
        ).length,
        1,
      );
      const run = relay.monitor.runs.find((run) => run.question === initial.text);
      assert.ok(run.steps.some((step) => step.kind === 'command' && step.title === 'keypress'));
      assert.ok(run.steps.some((step) => step.kind === 'command' && step.title === 'switch-tab'));
      assert.ok(
        !run.steps.some((step) => step.kind === 'command' && step.title === 'agent-decision'),
      );
      assert.equal(run.status, 'delivered');
    },
  );
  await check(
    'extension loop observes same-tab Enter navigation without guessed URL or false failure',
    async () => {
      const tab = await previewPanel(
        `chrome.tabs.create({url:${JSON.stringify(url + 'loop')},active:true})`,
      );
      await eventually(
        async () => (await previewPanel(`chrome.tabs.get(${tab.id})`)).status === 'complete',
      );
      let request = await askLoop('Loop: submit within the same tab', tab);
      await decision(request, {
        kind: 'actions',
        actions: [
          {
            method: 'use-current-tab',
            params: { contextId: request.request.payload.initialPage.contextId },
          },
        ],
      });
      request = await nextRound(request);
      const ref = refIn(request, 'Same tab query');
      await decision(request, {
        kind: 'actions',
        actions: [
          { method: 'fill', params: { ref, text: 'same' } },
          { method: 'keypress', params: { ref, key: 'Enter' } },
        ],
      });
      request = await nextRound(request);
      assert.equal(request.request.payload.failed, false, JSON.stringify(request.request.payload));
      assert.equal(request.request.payload.observation.target.id, tab.id);
      assert.ok(request.request.payload.observation.target.url.includes('/next?q=same'));
      await finishLoop(request, 'Same-tab search completed');
    },
  );
  await check(
    'extension loop returns real scroll metrics, loads later content, and stops pending decisions',
    async () => {
      const tab = await previewPanel(
        `chrome.tabs.create({url:${JSON.stringify(url + 'loop')},active:true})`,
      );
      await eventually(
        async () => (await previewPanel(`chrome.tabs.get(${tab.id})`)).status === 'complete',
      );
      let request = await askLoop('Loop: browse further down', tab);
      await decision(request, {
        kind: 'actions',
        actions: [
          {
            method: 'use-current-tab',
            params: { contextId: request.request.payload.initialPage.contextId },
          },
        ],
      });
      request = await nextRound(request);
      assert.ok(request.request.payload.observation.page.viewport.remainingBelow > 0);
      await decision(request, {
        kind: 'actions',
        actions: [{ method: 'scroll', params: { direction: 'down', pixels: 800 } }],
      });
      request = await nextRound(request);
      assert.equal(request.request.payload.failed, false, JSON.stringify(request.request.payload));
      assert.ok(request.request.payload.observation.page.viewport.scrollY > 0);
      assert.ok(request.request.payload.observation.page.text.includes('Lazy result loaded'));
      await decision(request, { kind: 'actions', actions: [{ method: 'observe', params: {} }] });
      request = await nextRound(request);
      const image = request.request.payload.observation.page.screenshot;
      assert.equal(image.data, undefined, 'image encoding must not reach Agent stdout');
      assert.equal(image.imageReadRequired, true);
      assert.equal(path.dirname(image.path), process.env.BROWSER_REMOTE_OBS_DIR);
      assert.ok(
        (await fs.readFile(image.path)).length > 100,
        'Agent host can read the real screenshot',
      );
      await previewPanel("chrome.runtime.sendMessage({type:'remote-stop'})");
      await assert.rejects(
        decision(request, {
          kind: 'actions',
          actions: [{ method: 'click', params: { x: 10, y: 10 } }],
        }),
        (error) => error.code === 'STALE_DECISION',
      );
      assert.equal((await panelState()).task, null);
      assert.ok(await previewPanel(`chrome.tabs.get(${tab.id})`), 'borrowed tab remains open');
    },
  );
  await check(
    'extension loop edits forms and reads state while retaining the original page group',
    async () => {
      const tab = await previewPanel(
        `chrome.tabs.create({url:${JSON.stringify(url)},active:true})`,
      );
      await eventually(
        async () => (await previewPanel(`chrome.tabs.get(${tab.id})`)).status === 'complete',
      );
      const group = await previewPanel(
        `chrome.tabs.group({tabIds:[${tab.id}],createProperties:{windowId:${tab.windowId}}})`,
      );
      let request = await askLoop('Loop: edit form in the original page', tab);
      const action = async (method, params = {}) => {
        await decision(request, { kind: 'actions', actions: [{ method, params }] });
        request = await nextRound(request);
        assert.equal(
          request.request.payload.failed,
          false,
          JSON.stringify(request.request.payload),
        );
        return request.request.payload.observation.page;
      };
      await action('use-current-tab', { contextId: request.request.payload.initialPage.contextId });
      const find = async (selector) => (await action('find', { selector })).matches[0].ref;
      const inspect = async (selector) => action('inspect', { ref: await find(selector) });
      await action('fill', { ref: await find('#input'), text: 'A retained draft' });
      assert.equal((await inspect('#input')).value, 'A retained draft');
      await action('check', { ref: await find('#check'), checked: true });
      assert.equal((await inspect('#check')).checked, true);
      await action('select', { ref: await find('#select'), values: ['b'] });
      assert.equal((await inspect('#select')).value, 'b');
      await action('click', { ref: await find('#click') });
      assert.equal((await inspect('#click')).text, 'Clicked 1');
      await finishLoop(request, 'Form updated');
      assert.equal((await previewPanel(`chrome.tabs.get(${tab.id})`)).groupId, group);
      await previewPanel(`chrome.tabs.remove(${tab.id})`);
    },
  );
  await check('extension loop reads iframe elements and refuses sensitive input', async () => {
    let request = await askLoop('Loop: read frame and check sensitive input');
    const action = async (method, params = {}) => {
      await decision(request, { kind: 'actions', actions: [{ method, params }] });
      request = await nextRound(request);
      return request.request.payload;
    };
    await action('open', { url: url + 'far-frame' });
    const field = (await action('find', { selector: 'input[type=password]' })).observation.page
      .matches[0];
    const denied = await action('fill', { ref: field.ref, text: 'must not type' });
    assert.equal(denied.failed, true);
    assert.ok(denied.results.some((result) => result.error?.code === 'SENSITIVE_INPUT'));
    const frameData = (await action('frames')).observation.page;
    const frames = Array.isArray(frameData) ? frameData : frameData.frames;
    const frame = frames.find((frame) => frame.url.includes('/frame'));
    assert.ok(frame, JSON.stringify(frameData));
    const matches = (
      await action('find', { selector: '#frame-button', frameId: frame.frameId || frame.id })
    ).observation.page.matches;
    assert.equal(matches.length, 1);
    assert.ok(matches[0].ref);
    await finishLoop(request, 'Frame read; sensitive input left to the user');
  });
  console.log(
    JSON.stringify(
      { passed: checks.length, checks, measurements, browser: await cdp('Browser.getVersion') },
      null,
      2,
    ),
  );
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    await new Promise((resolve) => {
      browser.once('exit', resolve);
      setTimeout(resolve, 3000).unref();
    });
  }
  relay?.close();
  await new Promise((resolve) => (site ? site.close(resolve) : resolve()));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
