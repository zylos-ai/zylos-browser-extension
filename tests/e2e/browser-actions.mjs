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
const stopMessages = [];
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
  if (url.startsWith('/lazy-list'))
    return `<!doctype html><meta charset="utf-8"><title>Delayed 200 app list</title>
    <style>body{margin:0;font:16px system-ui}.row{height:70px;margin:0}#loading{height:20px}</style>
    <main id="list"></main><div id="loading" role="status"></div>
    <script>
    let count=0,busy=false;const list=document.querySelector('#list'),status=document.querySelector('#loading');
    function append(){for(let i=0;i<40;i++){count++;const p=document.createElement('p');p.className='row';p.textContent='Lazy App '+String(count).padStart(3,'0')+' Revenue USD '+count*100+' Downloads '+count*1000;list.append(p)}}
    append();addEventListener('scroll',async()=>{if(busy||count>=200||scrollY+innerHeight<document.documentElement.scrollHeight-350)return;
      busy=true;status.textContent='Loading more';list.setAttribute('aria-busy','true');
      await new Promise(r=>setTimeout(r,450));await fetch('/delayed-data?ms=850');append();
      list.removeAttribute('aria-busy');status.textContent=count===200?'End of list':'';busy=false;
    });</script>`;
  if (url.startsWith('/async-controls'))
    return `<!doctype html><title>Asynchronous controls</title>
    <button id="filter" onclick="load(1100,'Filtered results')">Filter</button>
    <button id="slow" onclick="load(6500,'Slow results')">Slow filter</button>
    <button id="forever" onclick="document.querySelector('#result').setAttribute('aria-busy','true')">Keep loading</button>
    <p id="result">Initial results</p><div id="inner" style="height:240px;overflow:auto">${Array.from({ length: 4 }, (_, i) => `<p style="height:80px;margin:0">Nested ${i + 1}</p>`).join('')}</div>
    <script>
    window.filterClicks=0;async function load(ms,text){window.filterClicks++;const r=document.querySelector('#result');r.setAttribute('aria-busy','true');await fetch('/delayed-data?ms='+ms);r.textContent=text;r.removeAttribute('aria-busy')}
    let loaded=false;const panel=document.querySelector('#inner');panel.addEventListener('scroll',async()=>{if(loaded)return;loaded=true;panel.setAttribute('aria-busy','true');await fetch('/delayed-data?ms=950');for(let i=5;i<=8;i++){const p=document.createElement('p');p.style='height:80px;margin:0';p.textContent='Nested '+i;panel.append(p)}panel.removeAttribute('aria-busy')});
    </script>`;
  if (url.startsWith('/observation-list'))
    return `<!doctype html><meta charset="utf-8"><title>200 app observations</title>
    <style>body{margin:0;font:16px system-ui}table{border-collapse:collapse;width:100%}td{height:90px;border-bottom:1px solid #ccc;padding:4px}button{position:fixed;right:30px;top:5px}</style>
    <a hidden id="hidden-apps" href="/observation-list?category=apps">Hidden application tab</a>
    <a id="visible-category" href="/observation-list?category=health">Health category</a>
    <table><thead><tr><th>App</th><th>Revenue</th><th>Downloads</th></tr></thead><tbody>
    ${Array.from({ length: 200 }, (_, i) => `<tr><td>App ${String(i + 1).padStart(3, '0')}</td><td>Revenue USD ${(i + 1) * 100}</td><td>Downloads ${(i + 1) * 1000}</td></tr>`).join('')}</tbody></table>`;
  if (url.startsWith('/observation-containers'))
    return `<!doctype html><title>Clipped observation</title><style>body{margin:0}#inner{height:180px;overflow:auto}iframe{height:130px;width:500px}p{margin:0;height:90px}</style>
    <div id="inner">${Array.from({ length: 40 }, (_, i) => `<p>Inner row ${i + 1}</p>`).join('')}</div>
    <iframe src="http://localhost:${port}/frame"></iframe>
    <div id="shadow"></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<p>Visible shadow content</p>';</script>
    <p style="visibility:hidden">HIDDEN_LAYOUT_TEXT</p><div style="opacity:0"><p>TRANSPARENT_LAYOUT_TEXT</p></div>
    <input type="password" value="PRIVATE_PASSWORD"><input autocomplete="one-time-code" value="PRIVATE_OTP">
    <div style="height:3000px"></div><iframe src="http://localhost:${port}/frame?offscreen=1"></iframe>`;
  if (url.startsWith('/selection-mixed'))
    return `<!doctype html><meta charset="utf-8"><title>Mixed video-page selection</title><section>
    <h1>007初露锋芒格斗场获取拍卖费6万-游戏通关攻略解说</h1>
    <p>681 · 0 · 2026-06-14 10:22:17</p><p>01:45 / 09:14 · 1080P 60帧 · 倍速</p>
    <input hidden value="PRIVATE_HIDDEN_FIELD"><input type="password" value="PRIVATE_PASSWORD">
    <textarea placeholder="发个友善的弹幕见证当下">PRIVATE_TEXTAREA</textarea>
    <div contenteditable>PRIVATE_DRAFT</div><span style="display:none">PRIVATE_HIDDEN_TEXT</span>
    <a href="#">弹幕礼仪</a><p>视频说明结尾</p></section>`;
  if (url.startsWith('/article'))
    return `<!doctype html><title>Read-only article</title><link rel="icon" href="/fixture-icon.svg"><h1>Article heading</h1>
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
    if (req.url.startsWith('/delayed-data')) {
      const ms = Math.min(
        8000,
        Number(new URL(req.url, 'http://localhost').searchParams.get('ms')) || 0,
      );
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end('{"loaded":true}');
      }, ms);
      return;
    }
    if (req.url === '/fixture-icon.svg') {
      res.setHeader('content-type', 'image/svg+xml');
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="#168b83"/><path d="M22 9H10v14h12" fill="none" stroke="white" stroke-width="4"/></svg>',
      );
      return;
    }
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
    onStop: async (event) => {
      stopMessages.push(event);
      await sleep(300);
      return { ok: true }; // Never interrupt the developer's live Agent.
    },
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
      `chrome.runtime.sendMessage(${JSON.stringify({ type: 'remote-chat-send', message: { role: 'user', content: [{ type: 'text', text }] }, ...(tab ? { tabId: tab.id, windowId: tab.windowId } : {}) })})`,
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
      body: JSON.stringify({
        endpoint: request.endpointId,
        id: request.request.id,
        decision: value,
      }),
    });
    const body = await response.json();
    if (!body.ok)
      throw Object.assign(new Error(`${body.code}: ${body.message}`), { code: body.code });
    if (body.next && !chatMessages.some((message) => message.request?.id === body.next.id))
      chatMessages.push({
        endpointId: body.next.endpointId,
        text: request.text,
        chatId: body.next.taskId,
        request: body.next,
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
    const line = request.request.execution.observation.page.text
      .split('\n')
      .find((line) => line.includes(JSON.stringify(label)));
    assert.ok(
      line,
      `Missing ref ${label}: ${JSON.stringify(request.request.execution.observation)}`,
    );
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
    'selected prose is previewed, sent once with its source page, and removable without CDP',
    async () => {
      const tab = await previewPanel(
        `chrome.tabs.create({url:${JSON.stringify(url + 'article')},active:true})`,
      );
      await eventually(
        async () => (await previewPanel(`chrome.tabs.get(${tab.id})`)).status === 'complete',
      );
      await workerEval('debuggerCalls.length = 0');
      const select = async (selector) =>
        previewPanel(`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:() => {
        const range = document.createRange(); range.selectNodeContents(document.querySelector(${JSON.stringify(selector)}));
        const selected = window.getSelection(); selected.removeAllRanges(); selected.addRange(range);
      }})`);
      await select('h2');
      await eventually(() =>
        previewPanel(
          "document.querySelector('.composer-field .selection-quote blockquote')?.textContent === 'Article ending'",
        ),
      );
      assert.equal(await previewPanel("!!document.querySelector('.current-page')"), false);
      await eventually(() =>
        previewPanel(`(() => {
        const icon = document.querySelector('.selection-chip-label img');
        return icon?.src === ${JSON.stringify(url + 'fixture-icon.svg')} && icon.complete && icon.naturalWidth > 0;
      })()`),
      );
      assert.equal(
        await previewPanel("document.querySelector('.selection-chip-label').textContent"),
        '',
      );
      assert.equal(
        await previewPanel(
          "getComputedStyle(document.querySelector('.selection-tooltip')).display",
        ),
        'none',
      );
      const fill = (text) =>
        previewPanel(`(() => {
        const input = document.querySelector('#message');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});
        input.dispatchEvent(new Event('input',{bubbles:true}));
      })()`);
      await fill('Selection: explain this passage');
      await previewPanel("document.querySelector('#message').focus()");
      await sleep(750);
      assert.equal(
        await previewPanel("!!document.querySelector('.selection-chip')"),
        true,
        'focusing the composer retains an existing page selection',
      );
      if (process.env.E2E_SCREENSHOT_DIR) {
        await cdp(
          'Emulation.setDeviceMetricsOverride',
          { width: 360, height: 820, deviceScaleFactor: 1, mobile: false },
          sessionId,
        );
        await fs.mkdir(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
        const shot = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
        await fs.writeFile(
          path.join(process.env.E2E_SCREENSHOT_DIR, 'selection-chip-360.png'),
          Buffer.from(shot.data, 'base64'),
        );
      }
      const chip = await previewPanel(`(() => {
        const r = document.querySelector('.selection-chip-label').getBoundingClientRect();
        return {x:r.x+r.width/2,y:r.y+r.height/2};
      })()`);
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...chip }, sessionId);
      await eventually(() => previewPanel("!document.querySelector('.selection-tooltip').hidden"));
      assert.equal(
        await previewPanel(`(() => {
          const r = document.querySelector('.selection-tooltip').getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth && r.top >= 0;
        })()`),
        true,
        'hover preview fits inside the narrow sidebar',
      );
      if (process.env.E2E_SCREENSHOT_DIR) {
        const shot = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
        await fs.writeFile(
          path.join(process.env.E2E_SCREENSHOT_DIR, 'selection-chip-hover-360.png'),
          Buffer.from(shot.data, 'base64'),
        );
      }
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }, sessionId);
      await eventually(() => previewPanel("document.querySelector('.selection-tooltip').hidden"));
      await previewPanel("document.querySelector('#send').click()");
      const request = await eventually(() =>
        chatMessages.find((m) => m.text === 'Selection: explain this passage'),
      );
      const quote = request.request.message.content[1];
      assert.equal(quote.type, 'quote');
      assert.equal(quote.text, 'Article ending');
      assert.equal(quote.truncated, false);
      assert.equal(quote.source.contextId, request.chatId);
      assert.equal(quote.source.documentId, undefined);
      assert.equal(request.request.context.pages[0].selection, undefined);
      assert.ok(
        !request.request.context.pages[0].text.includes('Article ending'),
        'selected text outside the excerpt is still attached',
      );
      assert.equal(request.request.context.pages[0].selection, undefined);
      assert.equal(
        (await panelState()).chat.find((entry) => entry.id === request.chatId).attachments[0].text,
        'Article ending',
      );
      assert.equal(
        await previewPanel("document.querySelector('.message.user').textContent"),
        'Selection: explain this passage',
        'the sent bubble shows user text while the quote and page still reach the Agent',
      );
      await eventually(() =>
        previewPanel("!document.querySelector('.composer-field .selection-quote')"),
      );
      await sleep(750);
      assert.equal(
        await previewPanel("!!document.querySelector('.composer-field .selection-quote')"),
        false,
      );
      assert.deepEqual(await workerEval('debuggerCalls'), []);
      await finishLoop(request, 'The selected ending was received.');
      await select('h1');
      await eventually(() =>
        previewPanel(
          "document.querySelector('.composer-field .selection-quote blockquote')?.textContent === 'Article heading'",
        ),
      );
      await previewPanel("document.querySelector('.selection-quote-remove').click()");
      await sleep(750);
      assert.equal(
        await previewPanel("!!document.querySelector('.composer-field .selection-quote')"),
        false,
      );
      await fill('Selection: send without a quote');
      await previewPanel("document.querySelector('#send').click()");
      const without = await eventually(() =>
        chatMessages.find((m) => m.text === 'Selection: send without a quote'),
      );
      assert.equal(without.request.context.pages[0].selection, undefined);
      assert.equal(without.request.message.content.length, 1);
      await finishLoop(without, 'No quote attached.');
      await select('h2');
      await eventually(() => previewPanel("!!document.querySelector('.selection-chip')"));
      await previewPanel(`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:() => {
        window.getSelection().removeAllRanges();
      }})`);
      await eventually(() => previewPanel("!document.querySelector('.selection-chip')"));
      await sleep(750);
      assert.equal(
        await previewPanel("!!document.querySelector('.selection-chip')"),
        false,
        'cancelled page selection must not return from the observer cache',
      );
      await fill('Selection: page selection cancelled');
      await previewPanel("document.querySelector('#send').click()");
      const cancelled = await eventually(() =>
        chatMessages.find((m) => m.text === 'Selection: page selection cancelled'),
      );
      assert.equal(cancelled.request.message.content.length, 1);
      await finishLoop(cancelled, 'Cancelled selection was not attached.');
      await previewPanel(`chrome.tabs.remove(${tab.id})`);
    },
  );
  await check(
    'selected prose across video controls keeps surrounding text without editor contents or CDP',
    async () => {
      const tab = await previewPanel(
        `chrome.tabs.create({url:${JSON.stringify(url + 'selection-mixed')},active:true})`,
      );
      await eventually(
        async () => (await previewPanel(`chrome.tabs.get(${tab.id})`)).status === 'complete',
      );
      await workerEval('debuggerCalls.length = 0');
      await previewPanel(`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:() => {
        const range = document.createRange(); range.selectNodeContents(document.querySelector('section'));
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      }})`);
      const text = await eventually(() =>
        previewPanel(
          "document.querySelector('.composer-field .selection-quote blockquote')?.textContent",
        ),
      );
      for (const expected of [
        '007初露锋芒',
        '681',
        '01:45 / 09:14',
        '1080P 60帧',
        '弹幕礼仪',
        '视频说明结尾',
      ])
        assert.ok(text.includes(expected), `mixed selection includes ${expected}: ${text}`);
      assert.ok(!text.includes('PRIVATE_'));
      await previewPanel(`(() => {
        const input = document.querySelector('#message');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Selection: explain video information');
        input.dispatchEvent(new Event('input',{bubbles:true}));
        document.querySelector('#send').click();
      })()`);
      const request = await eventually(() =>
        chatMessages.find((m) => m.text === 'Selection: explain video information'),
      );
      assert.equal(request.request.message.content[1].text, text);
      assert.deepEqual(await workerEval('debuggerCalls'), []);
      await finishLoop(request, 'Visible video information was received.');
      await previewPanel(`chrome.tabs.remove(${tab.id})`);
    },
  );
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
      const initial = request.request.context.pages[0];
      measurements.push({
        operation: 'message context (DOM)',
        elapsedMs: Math.round(performance.now() - started),
        outputBytes: Buffer.byteLength(JSON.stringify(initial)),
        debuggerCalls: (await workerEval('debuggerCalls')).length,
      });
      assert.equal(request.request.execution.mode, 'reading');
      assert.ok(initial.text.includes('Article heading'));
      assert.ok(!JSON.stringify(initial).includes('PRIVATE_'));
      assert.ok(initial.nextOffset > 0);
      assert.equal((await panelState()).task, null);
      await finishLoop(request, 'Hello');
      assert.deepEqual(await workerEval('debuggerCalls'), []);

      request = await askLoop('Article: summarize then perform the requested action', tab);
      const context = request.request.context.pages[0];
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
        const page = request.request.execution.observation.page;
        assert.equal(
          request.request.execution.failed,
          false,
          JSON.stringify(request.request.execution),
        );
        assert.equal(request.request.execution.mode, 'reading');
        assert.equal(
          request.request.execution.tools,
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
      assert.equal(request.request.execution.mode, 'operating');
      assert.ok(request.request.execution.tools.some((tool) => tool.name === 'click'));
      assert.equal(request.request.execution.observation.target.id, tab.id);
      assert.ok((await workerEval('debuggerCalls')).includes('attach'));
      await decision(request, {
        kind: 'actions',
        actions: [{ method: 'click', params: { ref: refIn(request, 'Article action') } }],
      });
      request = await nextRound(request);
      assert.ok(request.request.execution.observation.page.text.includes('Action confirmed'));
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
      const contextId = request.request.context.pages[0].contextId;
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
        assert.equal(request.request.execution.mode, 'reading');
        assert.ok(
          request.request.execution.results.some((result) => result.error?.code === 'PAGE_CHANGED'),
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
      await eventually(() => previewPanel("!document.querySelector('.live-preview')"));
      assert.equal(await previewPanel("!!document.querySelector('.preview-restore')"), false);
      const other = await previewPanel(
        `chrome.tabs.create({url:${JSON.stringify(url + 'next')},active:true})`,
      );
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
      await previewPanel(`chrome.tabs.update(${tab},{active:true})`);
      await eventually(() => previewPanel("!document.querySelector('.live-preview')"));
      await previewPanel(`chrome.tabs.update(${other.id},{active:true})`);
      await eventually(() => previewPanel("!!document.querySelector('.live-preview-image')"));
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
      await previewPanel(`chrome.tabs.update(${other.id},{active:true})`);
      await eventually(() => previewPanel("!!document.querySelector('.preview-restore')"));
      await previewPanel("document.querySelector('.preview-restore').click()");
      await eventually(() =>
        previewPanel(
          `Number(document.querySelector('.live-preview')?.dataset.tabId) === ${secondTab} && document.querySelector('.live-preview-image')?.naturalWidth > 0`,
        ),
      );
      await action('switch-tab', { tabId: tab });
      // The Agent changes its target without changing the user's active tab.
      await previewPanel(`chrome.tabs.update(${tab},{active:true})`);
      await eventually(() => previewPanel("!document.querySelector('.live-preview')"));
      await previewPanel(`chrome.tabs.update(${other.id},{active:true})`);
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
      await eventually(() => previewPanel("!document.querySelector('.live-preview')"));
      await previewPanel(`chrome.tabs.update(${other.id},{active:true})`);
      await eventually(() =>
        previewPanel("document.querySelector('.live-preview')?.dataset.status === 'completed'"),
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
      assert.equal(request.request.execution.protocol, 'browser-decision-v1');
      assert.equal(
        request.request.execution.tools.length,
        3,
        'ordinary chat does not receive the entire browser catalog',
      );
      await eventually(async () => (await panelState()).chatBusy);
      await previewPanel(`(() => {
        const input = document.querySelector('#message');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Draft for later');
        input.dispatchEvent(new Event('input', {bubbles:true}));
      })()`);
      assert.equal(await previewPanel("document.querySelector('#message').disabled"), false);
      assert.equal(await previewPanel("document.querySelector('#send').disabled"), false);
      assert.equal(await previewPanel("document.querySelector('#send').type"), 'button');
      await previewPanel(`(() => {
        document.querySelector('#message').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}));
        document.querySelector('#chat-form').dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}));
      })()`);
      assert.deepEqual(
        await previewPanel(
          "chrome.runtime.sendMessage({type:'remote-chat-send',message:{role:'user',content:[{type:'text',text:'Duplicate request'}]}})",
        ),
        { ok: false, error: 'ui.error.chatBusy' },
      );
      assert.equal((await panelState()).chat.at(-1).text, 'Loop: just say hello');
      await finishLoop(request, 'Hello from structured decision');
      await eventually(() => previewPanel("!document.querySelector('#send').disabled"));
      assert.equal(
        await previewPanel("document.querySelector('#message').value"),
        'Draft for later',
      );
      assert.equal((await panelState()).chatBusy, false);
      assert.deepEqual(
        (await previewPanel('chrome.tabs.query({})')).map((tab) => tab.id),
        before,
      );
    },
  );
  await check(
    'composer stops plain chat, waits for the runtime key receipt, and preserves the next draft',
    async () => {
      const request = await askLoop('Stop this pending reply');
      await eventually(() => previewPanel("document.querySelector('#send').type === 'button'"));
      const draft = await previewPanel("document.querySelector('#message').value");
      const before = stopMessages.length;
      await previewPanel("document.querySelector('#send').click()");
      await eventually(async () => (await panelState()).stopping);
      assert.equal(await previewPanel("document.querySelector('#send').disabled"), true);
      await previewPanel("document.querySelector('#send').click()");
      await eventually(async () => !(await panelState()).chatBusy);
      assert.equal(stopMessages.length, before + 1);
      assert.equal(stopMessages.at(-1).taskId, request.chatId);
      assert.equal(await previewPanel("document.querySelector('#message').value"), draft);
      assert.equal(await previewPanel("document.querySelector('#send').type"), 'submit');
      assert.equal(
        (await panelState()).chat.find((m) => m.id === request.chatId).loopStatus,
        'stopped',
      );
      const next = await askLoop('New task after stopping');
      await finishLoop(next, 'Next task completed');
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
            params: { contextId: request.request.context.pages[0].contextId },
          },
        ],
      });
      request = await nextRound(request);
      assert.equal(request.request.execution.observation.target.id, tab.id);
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
      assert.equal(
        request.request.execution.failed,
        false,
        JSON.stringify(request.request.execution),
      );
      assert.ok(
        request.request.execution.observation.target.url.includes('/next?q=spider'),
        JSON.stringify({
          payload: request.request.execution,
          tabs: await previewPanel('chrome.tabs.query({})'),
        }),
      );
      assert.notEqual(request.request.execution.observation.target.id, tab.id);
      assert.notEqual(request.request.execution.observation.target.id, unrelated.id);
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
            params: { contextId: request.request.context.pages[0].contextId },
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
      assert.equal(
        request.request.execution.failed,
        false,
        JSON.stringify(request.request.execution),
      );
      assert.equal(request.request.execution.observation.target.id, tab.id);
      assert.ok(request.request.execution.observation.target.url.includes('/next?q=same'));
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
            params: { contextId: request.request.context.pages[0].contextId },
          },
        ],
      });
      request = await nextRound(request);
      assert.ok(request.request.execution.observation.page.viewport.remainingBelow > 0);
      await decision(request, {
        kind: 'actions',
        actions: [{ method: 'scroll', params: { direction: 'down', pixels: 800 } }],
      });
      request = await nextRound(request);
      assert.equal(
        request.request.execution.failed,
        false,
        JSON.stringify(request.request.execution),
      );
      assert.ok(request.request.execution.observation.page.viewport.scrollY > 0);
      assert.equal(request.request.execution.observation.page.scope, 'viewport');
      assert.ok(
        !request.request.execution.observation.page.text.includes('Lazy result loaded'),
        'new content below the viewport is not visible yet',
      );
      await decision(request, { kind: 'actions', actions: [{ method: 'observe', params: {} }] });
      request = await nextRound(request);
      const image = request.request.execution.observation.page.screenshot;
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
          request.request.execution.failed,
          false,
          JSON.stringify(request.request.execution),
        );
        return request.request.execution.observation.page;
      };
      await action('use-current-tab', { contextId: request.request.context.pages[0].contextId });
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
      return request.request.execution;
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
  await check(
    'viewport observation reads all 200 rows and keeps screenshots explicit',
    async () => {
      const started = performance.now();
      let request = await askLoop('Viewport: collect 200 app rows');
      const action = async (method, params = {}) => {
        await decision(request, { kind: 'actions', actions: [{ method, params }] });
        request = await nextRound(request);
        return request.request.execution;
      };
      let e = await action('open', { url: url + 'observation-list' });
      const seen = new Set();
      let outputBytes = 0,
        screens = 0;
      for (;;) {
        assert.equal(e.failed, false, JSON.stringify(e));
        const page = e.observation.page;
        assert.equal(page.scope, 'viewport');
        assert.equal(page.truncated, false);
        assert.equal(page.screenshot, undefined, 'successful reading does not request screenshots');
        outputBytes += Buffer.byteLength(JSON.stringify(e));
        const ranks = [...page.text.matchAll(/App (\d{3})/g)].map((m) => Number(m[1]));
        assert.ok(ranks.length > 0, page.text);
        assert.ok(
          page.text.includes('Revenue USD') && page.text.includes('Downloads'),
          'injected data columns remain readable',
        );
        if (screens === 0)
          assert.ok(
            page.text.includes('/observation-list?category=health'),
            'actual visible link URL is supplied',
          );
        if (screens === 0)
          assert.ok(
            !ranks.includes(200) && ranks.length < 60,
            'only the current screen is returned',
          );
        const size = seen.size;
        ranks.forEach((rank) => seen.add(rank));
        assert.ok(seen.size > size, 'each scroll reveals new app rows');
        screens++;
        if (!page.viewport.remainingBelow) break;
        assert.ok(screens < 25, 'bounded 200-row scan');
        e = await action('scroll', {
          direction: 'down',
          pixels: Math.min(2000, Math.floor(page.viewport.height * 0.85)),
        });
      }
      assert.equal(seen.size, 200, 'every app row was observed');
      const hidden = (await action('find', { selector: '#hidden-apps' })).observation.page
        .matches[0];
      assert.equal(hidden.state.visible, false);
      assert.equal(hidden.state.href, url + 'observation-list?category=apps');
      e = await action('click', { ref: hidden.ref });
      assert.equal(e.failed, true);
      assert.equal(
        e.observation.page.screenshot,
        undefined,
        'errors never trigger automatic images',
      );
      const image = (await action('observe')).observation.page.screenshot;
      assert.equal(image.data, undefined, 'Base64 must not appear in Agent output');
      assert.equal(image.imageReadRequired, true);
      assert.equal(path.dirname(image.path), process.env.BROWSER_REMOTE_OBS_DIR);
      const png = await fs.readFile(image.path);
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      const preview = path.join(os.tmpdir(), 'zylos-viewport-recovery.png');
      await fs.writeFile(preview, png);
      measurements.push({
        scenario: 'viewport-200-rows',
        screens,
        rows: seen.size,
        outputBytes,
        elapsedMs: Math.round(performance.now() - started),
        imageBytes: png.length,
        preview,
      });
      await finishLoop(request, '200 rows collected; hidden control correctly rejected');
    },
  );
  await check(
    'viewport observation clips nested scrolling, frames and shadow content without automatic images',
    async () => {
      let request = await askLoop('Viewport: inspect clipped containers');
      const action = async (method, params = {}) => {
        await decision(request, { kind: 'actions', actions: [{ method, params }] });
        request = await nextRound(request);
        assert.equal(
          request.request.execution.failed,
          false,
          JSON.stringify(request.request.execution),
        );
        return request.request.execution.observation;
      };
      let observation = await action('open', { url: url + 'observation-containers' });
      let text = observation.page.text;
      assert.ok(text.includes('Inner row 1') && !text.includes('Inner row 30'), text);
      assert.ok(text.includes('Visible shadow content'), text);
      assert.ok(text.includes('Frame button'), text);
      assert.equal(
        (text.match(/Frame:.*\/frame/g) || []).length,
        1,
        'offscreen iframe contents are excluded',
      );
      for (const privateText of [
        'HIDDEN_LAYOUT_TEXT',
        'TRANSPARENT_LAYOUT_TEXT',
        'PRIVATE_PASSWORD',
        'PRIVATE_OTP',
      ])
        assert.ok(!text.includes(privateText), privateText);
      const ref = (await action('find', { selector: '#inner' })).page.matches[0].ref;
      observation = await action('scroll', { direction: 'down', pixels: 600, ref });
      text = observation.page.text;
      assert.ok(!text.includes('"Inner row 1"') && text.includes('Inner row 8'), text);
      assert.equal(observation.page.viewport.scrollY, 0, 'only the inner container moved');
      await action('scroll', { direction: 'up' });
      observation = await action('scroll', { direction: 'up' });
      assert.equal(
        observation.page.screenshot,
        undefined,
        'unchanged observations do not trigger images',
      );
      observation = await action('scroll', { direction: 'up' });
      assert.equal(observation.page.screenshot, undefined, 'no consecutive automatic images');
      await finishLoop(request, 'Nested viewport verified');
    },
  );
  await check(
    'delayed lazy rows are retained across screens and incomplete completion is refused',
    async () => {
      const started = performance.now();
      let request = await askLoop('Read all 200 lazy app entries and retain sources');
      const step = async (actions) => {
        await decision(request, { kind: 'actions', actions });
        request = await nextRound(request);
        const e = request.request.execution;
        assert.equal(e.failed, false, JSON.stringify(e));
        return e;
      };
      let e = await step([{ method: 'open', params: { url: url + 'lazy-list' } }]);
      let screens = 0,
        outputBytes = 0;
      const seen = new Set();
      for (;;) {
        const page = e.observation.page;
        assert.equal(page.readiness.status, 'stable', JSON.stringify(page.readiness));
        assert.equal(page.screenshot, undefined);
        const ranks = [...page.text.matchAll(/Lazy App (\d{3})/g)].map((m) => +m[1]);
        assert.ok(ranks.length, page.text);
        ranks.forEach((n) => seen.add(n));
        screens++;
        outputBytes += Buffer.byteLength(JSON.stringify(e));
        const record = {
          method: 'record-findings',
          params: {
            collection: 'US app chart',
            targetCount: 200,
            items: ranks.map((n) => ({
              key: String(n),
              position: n,
              title: `App ${n}`,
              summary: `Revenue USD ${n * 100}; Downloads ${n * 1000}`,
              sourceUrl: url + 'lazy-list',
            })),
          },
        };
        if (seen.size === 200) {
          e = await step([record]);
          break;
        }
        assert.ok(screens < 24, 'bounded scan');
        e = await step([
          record,
          {
            method: 'scroll',
            params: {
              direction: 'down',
              pixels: Math.min(2000, Math.floor(page.viewport.height * 0.85)),
            },
          },
        ]);
        if (screens === 1) {
          await decision(request, { kind: 'done', text: 'Premature completion' });
          request = await nextRound(request);
          assert.ok(request.request.execution.results.some((r) => r.status === 'incomplete'));
          assert.equal(
            request.request.execution.research.collections[0].remaining,
            200 - seen.size,
          );
        }
      }
      assert.deepEqual(e.research.collections[0], {
        name: 'US app chart',
        collected: 200,
        covered: 200,
        targetCount: 200,
        remaining: 0,
      });
      e = await step([
        { method: 'read-findings', params: { collection: 'US app chart', offset: 195, limit: 10 } },
      ]);
      const saved = e.results.find((r) => r.method === 'read-findings').result;
      assert.equal(saved.total, 200);
      assert.equal(saved.nextOffset, null);
      assert.ok(saved.items.some((i) => i.position === 200));
      measurements.push({
        scenario: 'lazy-200-rows',
        rows: seen.size,
        screens,
        elapsedMs: Math.round(performance.now() - started),
        outputBytes,
      });
      await finishLoop(request, 'All 200 entries recorded');
    },
  );
  await check(
    'shared observation waits for async filters and container loading; slow results can be re-observed without replay',
    async () => {
      let request = await askLoop('Observe asynchronous page updates');
      const action = async (method, params = {}) => {
        await decision(request, { kind: 'actions', actions: [{ method, params }] });
        request = await nextRound(request);
        const e = request.request.execution;
        assert.equal(e.failed, false, JSON.stringify(e));
        return e.observation.page;
      };
      let page = await action('open', { url: url + 'async-controls' });
      const filter = (await action('find', { selector: '#filter' })).matches[0].ref;
      page = await action('click', { ref: filter });
      assert.ok(page.text.includes('Filtered results'), page.text);
      assert.equal(page.readiness.status, 'stable');
      const ref = (await action('find', { selector: '#inner' })).matches[0].ref;
      page = await action('scroll', { ref, direction: 'down', pixels: 700 });
      assert.equal(page.viewport.scrollY, 0);
      assert.equal(page.readiness.scroll.height, 640, 'waited for delayed nested rows');
      const nextRef = (await action('find', { selector: '#inner' })).matches[0].ref;
      page = await action('scroll', { ref: nextRef, direction: 'down', pixels: 700 });
      assert.ok(page.text.includes('Nested 8'), page.text);
      const slow = (await action('find', { selector: '#slow' })).matches[0].ref;
      page = await action('click', { ref: slow });
      assert.equal(page.readiness.status, 'loading', JSON.stringify(page.readiness));
      assert.ok(!page.text.includes('Slow results'));
      page = await action('wait-for-page');
      assert.equal(page.readiness.status, 'stable');
      assert.ok(page.text.includes('Slow results'), page.text);
      const info = (await previewPanel('chrome.tabs.query({})')).find(
        (t) => t.url === url + 'async-controls',
      );
      assert.equal(
        await previewPanel(
          `chrome.scripting.executeScript({target:{tabId:${info.id}},world:'MAIN',func:()=>window.filterClicks}).then(r=>r[0].result)`,
        ),
        2,
        'inputs were never replayed',
      );
      const forever = (await action('find', { selector: '#forever' })).matches[0].ref;
      page = await action('click', { ref: forever });
      assert.equal(page.readiness.status, 'loading');
      const pending = decision(request, {
        kind: 'actions',
        actions: [{ method: 'wait-for-page', params: { timeoutMs: 8000 } }],
      });
      await sleep(250);
      await previewPanel(`chrome.runtime.sendMessage({type:'remote-stop'})`);
      await pending;
      assert.equal((await panelState()).task, null, 'stop revoked control during the wait');
    },
  );
  await check(
    'Agent progress descriptions pass through the relay without extra decisions',
    async () => {
      const request = await askLoop('Read the fixture page with a public progress description');
      const summary = '读取资料页面，查找本次任务需要的信息。';
      await decision(request, {
        kind: 'actions',
        actions: [{ method: 'open', params: { url: url + 'next' } }],
        memory: 'Internal task continuation notes',
        summary,
      });
      const next = await nextRound(request);
      const steps = (await panelState()).chat.flatMap((entry) => entry.toolRun?.steps || []);
      assert.equal(steps.filter((step) => step.summary === summary).length, 1);
      await eventually(() =>
        previewPanel(
          `document.querySelector('.tool-activity-context')?.textContent === ${JSON.stringify(summary)}`,
        ),
      );
      assert.equal(
        await previewPanel(
          "document.querySelector('.tool-activity').textContent.includes('Internal task continuation notes')",
        ),
        false,
      );
      assert.equal(next.request.round, request.request.round + 1);
      await finishLoop(next, 'Fixture read complete');
    },
  );
  await check(
    'compact progress stays quiet at sidebar widths and collapses after completion',
    async () => {
      // Render fixture events through the real panel listener in this disposable profile.
      // Keep raw tool failures in the event, so presentation is checked independently.
      await workerEval("chrome.storage.local.set({uiLanguage:'zh-CN'})");
      await cdp(
        'Emulation.setDeviceMetricsOverride',
        { width: 360, height: 760, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
      const now = Date.now();
      const state = {
        ...(await panelState()),
        task: null,
        loopActive: true,
        chatBusy: true,
        error: '',
        chat: [
          {
            role: 'user',
            text: '帮我看看当前页面，整理几个适合个人开发者的方向。',
            ts: now - 689000,
          },
          {
            role: 'system',
            text: '',
            ts: now - 680000,
            toolRun: {
              status: 'running',
              startedAt: now - 680000,
              total: 30,
              failed: 1,
              steps: [
                {
                  id: 'open',
                  number: 1,
                  method: 'open',
                  status: 'success',
                  queuedAt: now - 680000,
                },
                {
                  id: 'read',
                  number: 2,
                  method: 'snapshot',
                  status: 'success',
                  queuedAt: now - 679000,
                },
                {
                  id: 'old-click',
                  number: 3,
                  method: 'click',
                  status: 'error',
                  errorCode: 'ELEMENT_ERROR',
                  queuedAt: now - 678000,
                },
                {
                  id: 'click',
                  number: 4,
                  method: 'click',
                  status: 'running',
                  queuedAt: now - 1000,
                },
              ],
            },
          },
        ],
      };
      const update = () =>
        workerEval(
          `chrome.runtime.sendMessage(${JSON.stringify({ type: 'remote-updated', state })})`,
        );
      const screenshot = async (name) => {
        if (!process.env.E2E_SCREENSHOT_DIR) return;
        await fs.mkdir(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
        const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
        await fs.writeFile(
          path.join(process.env.E2E_SCREENSHOT_DIR, name + '.png'),
          Buffer.from(data, 'base64'),
        );
      };
      const activity = state.chat.pop();
      await update();
      await eventually(() =>
        previewPanel("document.querySelector('.tool-activity-title')?.textContent === '接通中'"),
      );
      assert.equal(await previewPanel("!!document.querySelector('.tool-activity-context')"), false);
      await screenshot('progress-waiting');
      state.chat.push(activity);
      await update();
      await eventually(() =>
        previewPanel(
          "document.querySelector('.tool-activity-context')?.textContent === '正在操作页面'",
        ),
      );
      const compact = await previewPanel(`(() => {
      const el=document.querySelector('.tool-activity');
      return { height:el.getBoundingClientRect().height, border:getComputedStyle(el).borderTopWidth,
        count:document.querySelectorAll('.tool-activity').length, text:el.textContent,
        overflow:document.documentElement.scrollWidth > innerWidth };
    })()`);
      assert.ok(compact.height <= 72, JSON.stringify(compact));
      assert.equal(compact.border, '0px');
      assert.equal(compact.count, 1);
      assert.equal(compact.overflow, false);
      assert.match(compact.text, /思考执行中/);
      assert.doesNotMatch(compact.text, /ELEMENT_ERROR|失败|成功|snapshot|工具调用/);
      await screenshot('progress-running');
      state.chat[1].toolRun.steps[3].status = 'success';
      state.chat[1].toolRun.steps.push(
        {
          id: 'find',
          number: 5,
          method: 'find',
          status: 'success',
          queuedAt: now - 800,
          summary: '查找榜单筛选条件，确认当前地区。',
        },
        { id: 'fill', number: 6, method: 'fill', status: 'success', queuedAt: now - 700 },
        { id: 'type', number: 7, method: 'type', status: 'success', queuedAt: now - 600 },
        { id: 'confirm', number: 8, method: 'click', status: 'success', queuedAt: now - 500 },
        {
          id: 'scroll',
          number: 9,
          method: 'scroll',
          status: 'running',
          queuedAt: now - 400,
          summary: '继续查看后面的应用，补齐下载量数据。',
        },
      );
      await update();
      await eventually(() =>
        previewPanel(
          "document.querySelector('.tool-activity-title')?.textContent === '思考执行中'",
        ),
      );
      assert.equal(
        await previewPanel("document.querySelector('.tool-activity-context')?.textContent"),
        '继续查看后面的应用，补齐下载量数据。',
      );
      await screenshot('progress-phase');

      await previewPanel("document.querySelector('.tool-activity-toggle').click()");
      assert.equal(
        await previewPanel("document.querySelector('.tool-activity-body').hidden"),
        false,
      );
      assert.equal(await previewPanel("document.querySelectorAll('.tool-overview li').length"), 7);
      state.loopActive = false;
      state.chatBusy = false;
      state.chat[1].toolRun.steps.at(-1).status = 'success';
      state.chat[1].toolRun.status = 'completed';
      state.chat[1].toolRun.endedAt = now;
      state.chat.push({
        role: 'assistant',
        text: '已整理好当前页面的信息。接下来可以从轻量记录和提醒类应用开始比较。',
        ts: now,
        final: true,
      });
      await update();
      await eventually(() =>
        previewPanel(
          "document.querySelector('.tool-activity-toggle')?.textContent === '用时 11:29'",
        ),
      );
      assert.equal(
        await previewPanel("document.querySelector('.tool-activity-body').hidden"),
        true,
      );
      await screenshot('progress-completed');
      await previewPanel("document.querySelector('.tool-activity-toggle').click()");
      await screenshot('progress-expanded');
      await cdp('Emulation.clearDeviceMetricsOverride', {}, sessionId);
      await workerEval(
        `chrome.runtime.sendMessage(${JSON.stringify({ type: 'remote-updated', state: await panelState() })})`,
      );
    },
  );
  await check(
    'welcome mascot rests between loops while examples fit the sidebar and respect reduced motion',
    async () => {
      const initial = await panelState();
      const state = { ...initial, chat: [], task: null, loopActive: false, chatBusy: false };
      await workerEval("chrome.storage.local.set({uiLanguage:'zh-CN'})");
      await workerEval(
        `chrome.runtime.sendMessage(${JSON.stringify({ type: 'remote-updated', state })})`,
      );
      await cdp(
        'Emulation.setEmulatedMedia',
        {
          features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
        },
        sessionId,
      );
      await eventually(() => previewPanel("!!document.querySelector('.welcome-mascot-head')"));
      await previewPanel('document.activeElement.blur()');
      const seek = (time) =>
        previewPanel(`(() => {
        const scene=document.querySelector('.welcome-scene');
        const animations=scene.getAnimations({subtree:true});
        animations.forEach(a => { a.pause(); a.currentTime=${time}; });
        return {count:animations.length,arm:getComputedStyle(scene.querySelector('.welcome-arm-click')).d,
          otherArm:getComputedStyle(scene.querySelector('.welcome-arm-scroll')).d,
          scroll:getComputedStyle(scene.querySelector('.welcome-browser-list')).transform};
      })()`);
      const snapshot = async (name) => {
        if (!process.env.E2E_SCREENSHOT_DIR) return;
        await fs.mkdir(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
        const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
        await fs.writeFile(
          path.join(process.env.E2E_SCREENSHOT_DIR, name + '.png'),
          Buffer.from(data, 'base64'),
        );
      };
      for (const width of [320, 380]) {
        await cdp(
          'Emulation.setDeviceMetricsOverride',
          { width, height: 760, deviceScaleFactor: 1, mobile: false },
          sessionId,
        );
        const start = await seek(0);
        assert.ok(start.count > 0);
        assert.equal(
          await previewPanel("document.querySelectorAll('.welcome-mascot .welcome-arm').length"),
          2,
        );
        assert.equal(await previewPanel("document.querySelector('.welcome-mascot image')"), null);
        await snapshot(`welcome-rest-${width}`);
        await seek(1380);
        await snapshot(`welcome-unroll-${width}`);
        const click = await seek(2160);
        assert.notEqual(click.arm, start.arm, 'the tentacle reaches the browser button');
        await snapshot(`welcome-click-${width}`);
        const scroll = await seek(4200);
        assert.notEqual(
          scroll.scroll,
          start.scroll,
          'browser content moves with the second tentacle',
        );
        await snapshot(`welcome-scroll-${width}`);
        const end = await seek(6000);
        assert.equal(end.arm, start.arm, 'the same arm curls back into its original pose');
        for (const time of [6100, 7500, 8999]) {
          assert.deepEqual(await seek(time), start, 'the scene rests for 3 seconds between loops');
        }
        await snapshot(`welcome-pause-${width}`);
        assert.equal((await seek(11160)).arm, click.arm, 'the next loop repeats the same gesture');
        const fits = await previewPanel(`(() => {
          const scene=document.querySelector('.welcome-scene'), r=scene.getBoundingClientRect();
          const input=document.querySelector('#message').getBoundingClientRect();
          return {hidden:scene.getAttribute('aria-hidden'),overflow:document.documentElement.scrollWidth>innerWidth,
            fits:r.left>=0&&r.right<=innerWidth&&r.bottom<input.top,input:input.bottom<=innerHeight};
        })()`);
        assert.deepEqual(fits, { hidden: 'true', overflow: false, fits: true, input: true });
      }
      for (const language of ['zh-CN', 'en']) {
        await workerEval(`chrome.storage.local.set({uiLanguage:${JSON.stringify(language)}})`);
        await eventually(() =>
          previewPanel(
            `document.querySelector('.starter')?.textContent.includes(${JSON.stringify(language === 'en' ? 'Summarize' : '总结')})`,
          ),
        );
        await cdp(
          'Emulation.setDeviceMetricsOverride',
          { width: 320, height: 760, deviceScaleFactor: 1, mobile: false },
          sessionId,
        );
        const examples = await previewPanel(`(() => {
          const buttons=[...document.querySelectorAll('.starter')];
          return {count:buttons.length, fits:buttons.every(b => {
            const label=b.firstElementChild,r=b.getBoundingClientRect(),t=label.getBoundingClientRect();
            return t.left>=r.left&&t.right<=r.right&&t.bottom<=r.bottom&&label.scrollHeight<=label.clientHeight;
          }), text:buttons.map(b=>b.firstElementChild.textContent)};
        })()`);
        assert.equal(examples.count, 3);
        assert.equal(examples.fits, true);
        const sent = chatMessages.length;
        await previewPanel("document.querySelectorAll('.starter')[2].click()");
        assert.equal(
          await previewPanel("document.querySelector('#message').value"),
          examples.text[2],
        );
        assert.equal(chatMessages.length, sent, 'choosing an example only drafts it');
        await snapshot(`welcome-examples-${language}-320`);
      }
      await previewPanel(
        "document.querySelector('.welcome-scene').getAnimations({subtree:true}).forEach(a=>a.play());document.querySelector('#message').focus()",
      );
      assert.equal(
        await previewPanel(
          "getComputedStyle(document.querySelector('.welcome-arm-click')).animationPlayState",
        ),
        'running',
      );
      await cdp(
        'Emulation.setEmulatedMedia',
        { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] },
        sessionId,
      );
      assert.equal(
        await previewPanel(
          "getComputedStyle(document.querySelector('.welcome-arm-click')).animationName",
        ),
        'none',
      );
      await snapshot('welcome-reduced-motion');
      await cdp('Emulation.setEmulatedMedia', { features: [] }, sessionId);
      await cdp('Emulation.clearDeviceMetricsOverride', {}, sessionId);
      await workerEval(
        `chrome.runtime.sendMessage(${JSON.stringify({ type: 'remote-updated', state: initial })})`,
      );
    },
  );
  await check(
    'settings and header stay aligned in narrow Chinese and English sidebars',
    async () => {
      const state = {
        ...(await panelState()),
        chat: [{ role: 'assistant', text: 'A saved reply', ts: Date.now(), final: true }],
      };
      await workerEval(
        `chrome.runtime.sendMessage(${JSON.stringify({ type: 'remote-updated', state })})`,
      );
      await eventually(() =>
        previewPanel("!document.querySelector('.clear-chat-button').disabled"),
      );
      await previewPanel("document.querySelector('.settings-button').click()");
      await eventually(() => previewPanel("!!document.querySelector('#settings')"));
      assert.equal(
        await previewPanel("!!document.querySelector('#settings .clear-chat-button')"),
        false,
      );
      assert.equal(await previewPanel("document.querySelector('#access-key').value"), '');
      assert.equal(await previewPanel("document.querySelector('#access-key').type"), 'password');
      for (const language of ['zh-CN', 'en']) {
        await previewPanel(
          `(() => { const select=document.querySelector('#interface-language');select.value=${JSON.stringify(language)};select.dispatchEvent(new Event('change',{bubbles:true})); })()`,
        );
        await eventually(() =>
          previewPanel(`document.documentElement.lang === ${JSON.stringify(language)}`),
        );
        for (const width of [320, 380]) {
          await cdp(
            'Emulation.setDeviceMetricsOverride',
            { width, height: 760, deviceScaleFactor: 1, mobile: false },
            sessionId,
          );
          await previewPanel(
            "document.activeElement.blur(); document.querySelector('#settings').scrollTop=0",
          );
          const layout = await previewPanel(`(() => {
          const main=document.querySelector('#settings'),input=document.querySelector('#relay-url');
          const header=document.querySelector('.sidebar-header'),clear=header.querySelector('.clear-chat-button');
          const boxes=[...main.querySelectorAll('input,select,button')].map(el=>el.getBoundingClientRect());
          return {overflow:document.documentElement.scrollWidth>innerWidth || main.scrollWidth>main.clientWidth,
            fits:boxes.every(box=>box.x>=0 && box.right<=innerWidth), font:getComputedStyle(input).fontSize,
            inputHeight:input.getBoundingClientRect().height, clearInHeader:header.contains(clear),
            controlsFit:boxes.every(box=>box.bottom<=innerHeight)};
        })()`);
          assert.equal(layout.overflow, false, JSON.stringify(layout));
          assert.equal(layout.fits, true, JSON.stringify(layout));
          assert.equal(layout.controlsFit, true, JSON.stringify(layout));
          assert.equal(layout.font, '13px');
          assert.equal(layout.inputHeight, 44);
          assert.equal(layout.clearInHeader, true);
          if (process.env.E2E_SCREENSHOT_DIR) {
            await fs.mkdir(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
            const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
            await fs.writeFile(
              path.join(process.env.E2E_SCREENSHOT_DIR, `settings-${language}-${width}.png`),
              Buffer.from(data, 'base64'),
            );
          }
        }
      }
      await previewPanel("document.querySelector('.settings-button').click()");
      await eventually(() => previewPanel("!document.querySelector('#settings')"));
      assert.equal(
        await previewPanel(
          "document.querySelector('.message.assistant').textContent.includes('A saved reply')",
        ),
        true,
      );
      await cdp('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    },
  );
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
