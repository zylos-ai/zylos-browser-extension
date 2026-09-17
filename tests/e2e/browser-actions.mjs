// Run against a disposable Chrome profile and the actual sibling thin relay.
// No user profile, external websites, C4 messages, or installed browser state.
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
const { start } = require(path.join(relayRoot, 'relay/server.js'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
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
    agentLoop: false, // Legacy RPC compatibility; extension-owned rounds are tested below separately.
    extPort: 0,
    agentPort: 0,
    monitor: true,
    monitorFile: path.join(profile, 'monitor.json'),
    agentMonitorDir: null,
    outboxFile: path.join(profile, 'chat-outbox.json'),
    onChat: async (message) => {
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
  async function rpc(method, params = {}, options = {}) {
    const response = await fetch(rpcUrl + '/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        method,
        params,
        requestId: crypto.randomUUID(),
        timeoutMs: 20000,
        ...options,
      }),
    });
    const body = await response.json();
    if (!body.ok)
      throw Object.assign(new Error(`${method}: ${body.code}: ${body.message}`), {
        code: body.code,
        details: body.details,
      });
    return body.result;
  }
  async function find(selector, frameId) {
    const result = await rpc('find', { selector, ...(frameId ? { frameId } : {}) });
    assert.equal(result.matches.length, 1, `${selector}: ${JSON.stringify(result)}`);
    return result.matches[0].ref;
  }
  const state = async (selector) => rpc('inspect', { ref: await find(selector) });
  const check = async (name, work) => {
    if (process.env.BROWSER_LOOP_ONLY === '1' && !name.startsWith('extension loop')) return;
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
  await check(
    'live preview streams real background-tab frames, stays anchored, and freezes on completion',
    async () => {
      await rpc('open', { url: url + 'preview' });
      await rpc('wait', { condition: 'loaded' });
      const tab = (await rpc('info')).control.tabId;
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
      await rpc('new-tab', { url: url + 'preview?second' });
      const secondTab = (await rpc('info')).control.tabId;
      assert.notEqual(secondTab, tab);
      await eventually(() =>
        previewPanel(
          `Number(document.querySelector('.live-preview')?.dataset.tabId) === ${secondTab} && document.querySelector('.live-preview-image')?.naturalWidth > 0`,
        ),
      );
      await rpc('switch-tab', { tabId: tab });
      await eventually(() =>
        previewPanel(
          `Number(document.querySelector('.live-preview')?.dataset.tabId) === ${tab} && document.querySelector('.live-preview-image')?.naturalWidth > 0`,
        ),
      );
      await rpc('finish');
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
      // A final reply releases control but leaves the preview and original tab available.
      await fetch(rpcUrl + '/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Preview fixture complete', final: true }),
      });
      await eventually(async () => (await rpc('info')).control === null);
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
    'extension supplies its guide and schemas through the unmodified RPC transport',
    async () => {
      const catalog = await rpc('describe');
      assert.equal(catalog.schemaVersion, 1);
      assert(catalog.instructions.includes('Browser operation guide'));
      assert(catalog.tools.some((tool) => tool.name === 'observe'));
      const details = await rpc('describe', { methods: ['fill', 'wait'] });
      assert.deepEqual(details.tools[0].parameters.required, ['ref', 'text']);
      assert.equal(details.tools[1].parameters.properties.timeoutMs.maximum, 60000);
      assert.equal((await rpc('info')).control, null, 'discovery does not create a browser task');
      await assert.rejects(
        rpc('describe', { method: 'not-in-extension' }),
        (error) => error.code === 'UNKNOWN_METHOD',
      );
    },
  );
  await check('one round trip opens, waits and observes; child steps remain visible', async () => {
    await previewPanel("chrome.runtime.sendMessage({type:'remote-chat-clear'})");
    const separateStart = performance.now();
    await rpc('open', { url });
    await rpc('wait', { condition: 'loaded' });
    const separate = await rpc('snapshot', { interactive: true });
    const separateMs = performance.now() - separateStart;
    const combinedStart = performance.now();
    const combined = await rpc('step', {
      action: { op: 'open', url },
      read: { op: 'snapshot', interactive: true },
    });
    const combinedMs = performance.now() - combinedStart;
    assert.equal(combined.completed, true);
    assert.deepEqual(
      combined.steps.map((s) => [s.method, s.status]),
      [
        ['open', 'success'],
        ['wait', 'success'],
        ['snapshot', 'success'],
      ],
    );
    assert(separate.text.includes('Browser actions fixture'));
    assert(combined.steps.at(-1).result.text.includes('Browser actions fixture'));
    await eventually(() => previewPanel("document.querySelectorAll('.tool-log-step').length >= 6"));
    assert.deepEqual(
      await previewPanel(
        "[...document.querySelectorAll('.tool-step-detail code')].slice(-3).map(e=>e.textContent)",
      ),
      ['open', 'wait', 'snapshot'],
    );
    console.log(
      'COMPARISON',
      JSON.stringify({
        workflow: 'open/wait/snapshot',
        separate: { rpcCalls: 3, ms: Math.round(separateMs) },
        combined: { rpcCalls: 1, ms: Math.round(combinedMs) },
        includesAgentInference: false,
      }),
    );
  });
  await check(
    'composite input reads its result and delayed navigation needs no destination URL',
    async () => {
      const input = await find('#input');
      const filled = await rpc('step', {
        action: { op: 'fill', ref: input, text: 'one call' },
        read: { op: 'inspect', ref: input },
      });
      assert.equal(filled.steps.at(-1).result.value, 'one call');
      const result = await rpc('step', {
        action: { op: 'click', ref: await find('#delayed-next') },
        wait: { condition: 'navigation', timeoutMs: 5000 },
        read: { op: 'find', selector: '#next' },
      });
      assert.equal(result.steps.at(-1).result.matches[0].state.text, 'Next page');
      assert.equal(result.steps[1].result.url, url + 'next');
      assert.equal(result.steps[1].result.navigated, true);
    },
  );
  await check(
    'navigation wait follows the actual redirect and observes its destination',
    async () => {
      await rpc('step', { action: { op: 'open', url }, read: { op: 'snapshot' } });
      const result = await rpc('step', {
        action: { op: 'click', ref: await find('#redirect-next') },
        wait: { condition: 'navigation', timeoutMs: 5000 },
        read: { op: 'snapshot' },
      });
      assert.equal(result.steps[1].result.url, url + 'next?actual=redirected');
      assert(result.steps.at(-1).result.text.includes('Title: Next page'));
    },
  );
  await check('navigation wait recognizes SPA changes and same-URL document reloads', async () => {
    await rpc('step', { action: { op: 'open', url }, read: { op: 'snapshot' } });
    const spa = await rpc('step', {
      action: { op: 'click', ref: await find('#spa') },
      wait: { condition: 'navigation', timeoutMs: 3000 },
      read: { op: 'find', selector: '#spa' },
    });
    assert.equal(spa.steps[1].result.url, url + 'spa');
    assert.equal(spa.steps.at(-1).result.matches[0].state.text, 'SPA opened');
    const reload = await rpc('step', {
      action: { op: 'click', ref: await find('#same-url-reload') },
      wait: { condition: 'navigation', timeoutMs: 3000 },
      read: { op: 'find', selector: '#spa' },
    });
    assert.equal(reload.steps[1].result.url, url + 'spa');
    assert.equal(reload.steps.at(-1).result.matches[0].state.text, 'Open SPA');
  });
  await check(
    'Enter submission waits for its real destination without predicting a query',
    async () => {
      const result = await rpc('step', {
        action: { op: 'keypress', ref: await find('#submit-input'), key: 'Enter' },
        wait: { condition: 'navigation', timeoutMs: 3000 },
        read: { op: 'find', selector: '#next' },
      });
      assert.equal(result.steps[1].result.url, url + 'next?q=');
      assert.equal(result.steps.at(-1).result.matches[0].state.text, 'Next page');
    },
  );
  await check(
    'an unchanged loaded page and child-frame navigation cannot satisfy navigation wait',
    async () => {
      await rpc('step', { action: { op: 'open', url }, read: { op: 'snapshot' } });
      for (const selector of ['#click', '#frame-only']) {
        const failure = await rpc('step', {
          action: { op: 'click', ref: await find(selector) },
          wait: { condition: 'navigation', timeoutMs: 500 },
          read: { op: 'snapshot' },
        }).catch((e) => e);
        assert.equal(failure.code, 'STEP_INCOMPLETE');
        assert.deepEqual(
          failure.details.steps.map((s) => s.status),
          ['success', 'error', 'skipped'],
        );
        assert.equal(failure.details.steps[1].error.code, 'WAIT_TIMEOUT');
      }
      assert.equal((await state('#click')).text, 'Clicked 1');
    },
  );
  await check(
    'navigation wait still enforces destination guards and can be interrupted',
    async () => {
      const blocked = await rpc('step', {
        action: { op: 'click', ref: await find('#delayed-blocked') },
        wait: { condition: 'navigation', timeoutMs: 3000 },
        read: { op: 'snapshot' },
      }).catch((e) => e);
      assert.equal(blocked.code, 'STEP_INCOMPLETE');
      assert.equal(blocked.details.steps[1].error.code, 'BLOCKED_URL');
      assert.equal(blocked.details.steps[2].status, 'skipped');
      await rpc('stop');
      await rpc('step', { action: { op: 'open', url }, read: { op: 'snapshot' } });
      const active = rpc('step', {
        action: { op: 'click', ref: await find('#click') },
        wait: { condition: 'navigation', timeoutMs: 10000 },
        read: { op: 'snapshot' },
      }).catch((e) => e);
      await eventually(() =>
        previewPanel(
          "[...document.querySelectorAll('.tool-log-step[data-status=running] .tool-step-detail code')].some(e=>e.textContent==='wait')",
        ),
      );
      await rpc('pause');
      const stopped = await active;
      assert.equal(stopped.code, 'STEP_INCOMPLETE');
      assert.equal(stopped.details.steps[1].error.code, 'STOPPED');
      assert.equal(stopped.details.steps[2].status, 'skipped');
    },
  );
  await check(
    'a failed wait preserves its click and retries never duplicate the completed action',
    async () => {
      await rpc('step', { action: { op: 'open', url }, read: { op: 'snapshot' } });
      const ref = await find('#click');
      const params = {
        action: { op: 'click', ref },
        wait: { condition: 'visible', selector: '#never', timeoutMs: 250 },
        read: { op: 'snapshot' },
      };
      const options = { requestId: 'e2e-composite-partial' };
      const failed = await rpc('step', params, options).catch((e) => e);
      assert.equal(failed.code, 'STEP_INCOMPLETE');
      assert.deepEqual(
        failed.details.steps.map((s) => s.status),
        ['success', 'error', 'skipped'],
      );
      assert.equal(failed.details.steps[1].error.code, 'WAIT_TIMEOUT');
      const retry = await rpc('step', params, options).catch((e) => e);
      assert.equal(retry.details.replayed, true);
      assert.equal((await state('#click')).text, 'Clicked 1');
      const valid = { action: { op: 'click', ref }, read: { op: 'inspect', ref } };
      const first = await rpc('step', valid, { requestId: 'e2e-composite-success' });
      assert.equal(first.steps.at(-1).result.text, 'Clicked 2');
      assert.equal(
        (await rpc('step', valid, { requestId: 'e2e-composite-success' })).replayed,
        true,
      );
      assert.equal((await state('#click')).text, 'Clicked 2');
    },
  );
  await check('stopping a composite wait cancels the observation and queued writes', async () => {
    const input = await find('#input');
    const active = rpc('step', {
      action: { op: 'fill', ref: input, text: 'before stop' },
      wait: { condition: 'visible', selector: '#never', timeoutMs: 10000 },
      read: { op: 'snapshot' },
    }).catch((e) => e);
    await eventually(() =>
      previewPanel(
        "!!document.querySelector('.tool-log-step[data-status=running] .tool-step-detail code') && [...document.querySelectorAll('.tool-log-step[data-status=running] .tool-step-detail code')].some(e=>e.textContent==='wait')",
      ),
    );
    const queued = rpc('fill', { ref: input, text: 'must not execute' }).catch((e) => e);
    await eventually(() =>
      previewPanel("!!document.querySelector('.tool-log-step[data-status=queued]')"),
    );
    await rpc('pause');
    const stopped = await active;
    assert.equal(stopped.code, 'STEP_INCOMPLETE');
    assert.equal(stopped.details.steps[1].error.code, 'STOPPED');
    assert.equal(stopped.details.steps[2].status, 'skipped');
    assert.equal((await queued).code, 'STOPPED');
    assert.equal((await state('#input')).value, 'before stop');
    const tab = (await rpc('info')).control.tabId;
    await rpc('finish');
    await previewPanel(`chrome.tabs.remove(${tab})`);
    await previewPanel("chrome.runtime.sendMessage({type:'remote-chat-clear'})");
  });
  await check(
    'Monitor expands composite stages including executed, failed and skipped parts',
    async () => {
      const { targetId: monitorTarget } = await cdp('Target.createTarget', {
        url: rpcUrl + '/monitor/',
      });
      const { sessionId: monitorSession } = await cdp('Target.attachToTarget', {
        targetId: monitorTarget,
        flatten: true,
      });
      await eventually(
        async () =>
          (
            await cdp(
              'Runtime.evaluate',
              {
                expression: `[...document.querySelectorAll('.compound-parts')].some(list=>list.textContent.includes('wait · 失败') && list.textContent.includes('snapshot · 未执行'))`,
                returnByValue: true,
              },
              monitorSession,
            )
          ).result.value,
      );
      await cdp(
        'Runtime.evaluate',
        {
          expression:
            "for (const list of document.querySelectorAll('.compound-parts')) list.closest('details').open=true",
        },
        monitorSession,
      );
      await cdp('Target.closeTarget', { targetId: monitorTarget });
    },
  );
  await check(
    'native media can be verified without repeated toggles and keeps playing after the final reply',
    async () => {
      const opened = await rpc('open', { url: url + 'media' });
      await rpc('wait', { condition: 'loaded' });
      const initial = (await rpc('find', { selector: '#player' })).matches[0];
      assert.equal(initial.state.media.paused, true);
      const toggle = await find('#play-toggle');
      await rpc('click', { ref: toggle });
      const playing = await eventually(async () => {
        const match = (await rpc('find', { selector: 'video,audio' })).matches[0];
        return !match.state.media.paused && match.state.media.readyState >= 3 && match;
      });
      assert.equal(playing.state.media.ended, false);
      assert.equal(playing.state.media.error, null);
      assert.equal(playing.state.media.duration, null, 'live streams have unbounded duration');
      await eventually(async () => {
        const next = await rpc('inspect', { ref: playing.ref });
        return next.media.currentTime > playing.state.media.currentTime;
      });
      assert.equal((await rpc('inspect', { ref: toggle })).ariaLabel, 'Pause');
      const target = (await cdp('Target.getTargets')).targetInfos.find(
        (t) => t.type === 'page' && t.url === url + 'media',
      );
      const { sessionId: mediaSession } = await cdp('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      });
      const mediaFacts = async () =>
        (
          await cdp(
            'Runtime.evaluate',
            {
              expression: `({paused:document.querySelector('#player').paused,
            time:document.querySelector('#player').currentTime,
            clicks:Number(document.querySelector('#play-toggle').dataset.clicks)})`,
              returnByValue: true,
            },
            mediaSession,
          )
        ).result.value;
      const before = await mediaFacts();
      const response = await fetch(rpcUrl + '/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Playback verified', final: true }),
      });
      assert.equal((await response.json()).ok, true);
      await eventually(async () => (await rpc('info')).control === null);
      const after = await eventually(async () => {
        const facts = await mediaFacts();
        return facts.time > before.time && facts;
      });
      assert.equal(after.paused, false);
      assert.equal(after.clicks, 1, 'observations and task completion never toggle playback');
      await cdp('Target.detachFromTarget', { sessionId: mediaSession });
      await previewPanel(`chrome.tabs.remove(${opened.tabId})`);
      await previewPanel("chrome.runtime.sendMessage({type:'remote-chat-clear'})");
    },
  );
  await check('sidebar renders and sends/receives chat through the relay', async () => {
    await eventually(
      async () =>
        (
          await cdp(
            'Runtime.evaluate',
            {
              expression:
                "!!document.querySelector('#message') && !document.querySelector('#message').disabled",
              returnByValue: true,
            },
            sessionId,
          )
        ).result.value,
    );
    // Validate the built CSS in Chrome: DaisyUI must not override our theme/layout.
    await cdp(
      'Emulation.setDeviceMetricsOverride',
      { width: 380, height: 820, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    await eventually(async () => {
      const result = await cdp(
        'Runtime.evaluate',
        {
          expression: `(() => {
          const button = getComputedStyle(document.querySelector('.starter'));
          const body = getComputedStyle(document.body);
          return { background: button.backgroundColor, alignment: button.justifyContent, height: button.height,
            font: body.fontFamily, fontSize: body.fontSize,
            header: document.querySelector('.sidebar-header').getBoundingClientRect().height,
            composerBottom: document.querySelector('.composer').getBoundingClientRect().bottom,
            overflow: document.documentElement.scrollWidth > innerWidth };
        })()`,
          returnByValue: true,
        },
        sessionId,
      );
      assert.deepEqual(result.result.value, {
        background: 'rgb(247, 247, 250)',
        alignment: 'space-between',
        height: '44px',
        font: 'system-ui, sans-serif',
        fontSize: '14px',
        header: 64,
        composerBottom: 820,
        overflow: false,
      });
      return true;
    });
    await cdp(
      'Runtime.evaluate',
      { expression: "document.querySelector('#message').focus()" },
      sessionId,
    );
    await cdp('Input.insertText', { text: 'Sidebar fixture message' }, sessionId);
    await cdp(
      'Runtime.evaluate',
      { expression: "document.querySelector('#send').click()" },
      sessionId,
    );
    await eventually(() =>
      chatMessages.some((message) => message.text === 'Sidebar fixture message'),
    );
    const reply = await fetch(rpcUrl + '/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Sidebar fixture reply' }),
    });
    assert.equal((await reply.json()).ok, true);
    await eventually(
      async () =>
        (
          await cdp(
            'Runtime.evaluate',
            {
              expression:
                "document.querySelector('#history').textContent.includes('Sidebar fixture reply')",
              returnByValue: true,
            },
            sessionId,
          )
        ).result.value,
    );
  });
  await check(
    'Markdown replies render, scroll locally at sidebar widths, and survive panel reload',
    async () => {
      const markdown = JSON.parse(
        await fs.readFile(path.join(root, 'tests/fixtures/markdown-message.json'), 'utf8'),
      ).text;
      const panel = async (expression) => {
        const result = await cdp(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          sessionId,
        );
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      };
      await panel("chrome.runtime.sendMessage({type:'remote-chat-clear'})");
      const reply = await fetch(rpcUrl + '/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: markdown }),
      });
      assert.equal((await reply.json()).ok, true);
      await eventually(() =>
        panel("document.querySelector('.markdown-body h1')?.textContent === '页面调研报告'"),
      );
      for (const width of [320, 380, 480]) {
        await cdp(
          'Emulation.setDeviceMetricsOverride',
          { width, height: 820, deviceScaleFactor: 1, mobile: false },
          sessionId,
        );
        const layout = await panel(`(() => {
          const md = document.querySelector('.markdown-body');
          const table = md.querySelector('.markdown-table-scroll');
          const code = md.querySelector('pre');
          return {
            heading: parseFloat(getComputedStyle(md.querySelector('h1')).fontSize),
            body: parseFloat(getComputedStyle(md).fontSize),
            list: getComputedStyle(md.querySelector('ol')).listStyleType,
            tableBounded: table.getBoundingClientRect().right <= innerWidth,
            codeBounded: code.getBoundingClientRect().right <= innerWidth,
            tableScroll: getComputedStyle(table).overflowX === 'auto',
            codeScroll: code.scrollWidth > code.clientWidth && getComputedStyle(code).overflowX === 'auto',
            overflow: document.documentElement.scrollWidth > innerWidth,
            columns: md.querySelectorAll('th').length,
            external: md.querySelector('a[href^="https:"]').target,
          };
        })()`);
        assert.ok(layout.heading > layout.body);
        assert.equal(layout.list, 'decimal');
        for (const field of ['tableBounded', 'codeBounded', 'tableScroll', 'codeScroll'])
          assert.equal(layout[field], true, `${width}: ${field}`);
        assert.equal(layout.overflow, false);
        assert.equal(layout.columns, 4);
        assert.equal(layout.external, '_blank');
      }
      await cdp(
        'Emulation.setDeviceMetricsOverride',
        { width: 380, height: 820, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
      if (process.env.E2E_SCREENSHOT_DIR) {
        await fs.mkdir(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
        for (const [name, selector] of [
          ['markdown-report', '.markdown-body h1'],
          ['markdown-code', '.markdown-body h3'],
        ]) {
          await panel(
            `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start'})`,
          );
          const shot = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
          await fs.writeFile(
            path.join(process.env.E2E_SCREENSHOT_DIR, `${name}.png`),
            Buffer.from(shot.data, 'base64'),
          );
        }
      }
      await panel("document.querySelector('[data-footnote-ref]').click()");
      assert.equal(await panel('location.hash'), '');
      assert.equal(
        await panel(
          "chrome.runtime.sendMessage({type:'remote-state'}).then(response => response.ok)",
        ),
        true,
      );
      await cdp('Page.reload', {}, sessionId);
      await eventually(() =>
        panel("document.querySelector('.markdown-body h1')?.textContent === '页面调研报告'"),
      );
      assert.equal(
        await panel("document.querySelectorAll('.markdown-body table tbody tr').length"),
        2,
      );
    },
  );
  await check(
    'compact progress groups tools, preserves diagnostics, flags unresolved errors and survives reload',
    async () => {
      const panel = async (expression) => {
        const result = await cdp(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          sessionId,
        );
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      };
      const screenshot = async (name) => {
        if (!process.env.E2E_SCREENSHOT_DIR) return;
        await fs.mkdir(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
        await panel("document.querySelector('.tool-activity').scrollIntoView({block:'start'})");
        const shot = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
        await fs.writeFile(
          path.join(process.env.E2E_SCREENSHOT_DIR, `${name}.png`),
          Buffer.from(shot.data, 'base64'),
        );
      };
      await panel("chrome.runtime.sendMessage({type:'remote-chat-clear'})");
      await panel("chrome.storage.local.set({uiLanguage:'zh-CN'})");
      await panel("document.querySelector('#message').focus()");
      await cdp('Input.insertText', { text: '打开示例网页，读取内容并查找按钮。' }, sessionId);
      await panel("document.querySelector('#send').click()");
      await eventually(() =>
        chatMessages.some((m) => m.text === '打开示例网页，读取内容并查找按钮。'),
      );
      const opened = await rpc('open', { url });
      await rpc('info');
      await rpc('describe');
      await rpc('snapshot');
      await rpc('snapshot');
      const waiting = rpc('wait', {
        condition: 'visible',
        selector: '#never',
        timeoutMs: 4000,
      }).catch((e) => e);
      await eventually(() =>
        panel("!!document.querySelector('.tool-log-step[data-status=running]')"),
      );
      const queued = rpc('find', { selector: '#click' });
      await eventually(() =>
        panel("!!document.querySelector('.tool-log-step[data-status=queued]')"),
      );
      assert.equal(
        await panel(
          "document.querySelector('.tool-activity-toggle').getAttribute('aria-expanded')",
        ),
        'false',
      );
      assert.equal(
        await panel(
          "getComputedStyle(document.querySelector('.tool-activity-body')).display === 'none'",
        ),
        true,
      );
      assert.equal(await panel('document.documentElement.scrollWidth > innerWidth'), false);
      await eventually(() =>
        panel(
          "document.querySelector('.tool-activity-title').textContent.includes('等待页面响应')",
        ),
      );
      assert.equal(await panel("document.querySelector('.tool-diagnostics').open"), false);
      await screenshot('steps-live');
      await panel("document.querySelector('.tool-activity-toggle').click()");
      await eventually(() => panel("!document.querySelector('.tool-activity-body').hidden"));
      assert.equal(
        await panel("document.querySelector('.tool-stage-list').textContent.includes('snapshot')"),
        false,
      );
      await screenshot('steps-live-expanded');
      assert.equal((await waiting).code, 'WAIT_TIMEOUT');
      await queued;
      await eventually(() =>
        panel(
          "document.querySelector('.tool-log-step[data-status=error]')?.textContent.includes('WAIT_TIMEOUT')",
        ),
      );
      const reply = await fetch(rpcUrl + '/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '已读取页面并找到按钮。等待条件未出现，相关步骤已记录。' }),
      });
      assert.equal((await reply.json()).ok, true);
      await eventually(() =>
        panel("document.querySelector('.tool-activity')?.dataset.status === 'completed'"),
      );
      assert.equal(
        await panel(
          "document.querySelector('.tool-activity-toggle').getAttribute('aria-expanded')",
        ),
        'false',
      );
      assert.equal(
        await panel(
          "getComputedStyle(document.querySelector('.tool-activity-body')).display === 'none'",
        ),
        true,
      );
      await eventually(() =>
        panel("document.querySelector('.live-preview')?.dataset.status === 'error'"),
      );
      await screenshot('steps-collapsed');
      await panel("document.querySelector('.tool-activity-toggle').click()");
      assert.equal(
        await panel(
          "getComputedStyle(document.querySelector('.tool-activity-body')).display === 'none'",
        ),
        false,
      );
      assert.deepEqual(
        await panel(
          "[...document.querySelectorAll('.tool-step-detail code')].map((el)=>el.textContent)",
        ),
        ['open', 'info', 'describe', 'snapshot', 'snapshot', 'wait', 'find'],
      );
      assert.equal(await panel("document.querySelectorAll('.tool-stage').length"), 4);
      assert.equal(
        await panel("document.querySelector('.tool-activity').dataset.outcome"),
        'attention',
      );
      assert.equal(
        await panel(
          "document.querySelector('.tool-stage-list').textContent.includes('WAIT_TIMEOUT')",
        ),
        false,
      );
      assert.equal(await panel("document.querySelector('.tool-diagnostics').open"), false);
      await screenshot('steps-expanded');
      await panel("document.querySelector('.tool-diagnostics summary').click()");
      assert.equal(await panel("document.querySelector('.tool-diagnostics').open"), true);
      await screenshot('steps-diagnostics');
      await cdp('Page.reload', {}, sessionId);
      await eventually(() =>
        panel(
          "document.querySelector('.tool-activity-toggle')?.getAttribute('aria-expanded') === 'false'",
        ),
      );
      assert.equal(await panel("document.querySelectorAll('.tool-log-step').length"), 7);
      assert.equal(await panel("document.querySelector('.tool-diagnostics').open"), false);
      await panel("document.querySelector('.tool-activity-toggle').click()");
      assert.equal(
        await panel(
          "document.querySelector('.tool-activity-body').textContent.includes('WAIT_TIMEOUT')",
        ),
        true,
      );
      await panel(`chrome.tabs.remove(${opened.tabId})`);
      await panel("chrome.runtime.sendMessage({type:'remote-chat-clear'})");
      await panel("chrome.storage.local.set({uiLanguage:'auto'})");
    },
  );
  await check(
    'a confirmed retry clears the progress warning and retains the original failure in diagnostics',
    async () => {
      await previewPanel("chrome.runtime.sendMessage({type:'remote-chat-clear'})");
      const opened = await rpc('open', { url });
      await rpc('wait', { condition: 'loaded' });
      const params = { condition: 'visible', selector: '#late', timeoutMs: 200 };
      await assert.rejects(rpc('wait', params), (error) => error.code === 'WAIT_TIMEOUT');
      await eventually(() =>
        previewPanel("document.querySelector('.tool-activity')?.dataset.outcome === 'attention'"),
      );
      await rpc('click', { ref: await find('#schedule') });
      // The fixture inserts the element after 300 ms; retry the exact same request.
      await sleep(350);
      await rpc('wait', params);
      await eventually(() =>
        previewPanel("document.querySelector('.tool-activity')?.dataset.outcome !== 'attention'"),
      );
      await fetch(rpcUrl + '/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Retry fixture completed', final: true }),
      });
      await eventually(() =>
        previewPanel("document.querySelector('.tool-activity')?.dataset.outcome === 'success'"),
      );
      await previewPanel("document.querySelector('.tool-activity-toggle').click()");
      await previewPanel("document.querySelector('.tool-diagnostics summary').click()");
      assert.equal(
        await previewPanel(
          "!!document.querySelector('.tool-log-step[data-status=error] .tool-step-error')",
        ),
        true,
      );
      assert.equal(
        await previewPanel(
          "document.querySelector('.tool-log-step[data-status=error] .tool-step-status').textContent.includes('成功') || document.querySelector('.tool-log-step[data-status=error] .tool-step-status').textContent.includes('succeeded')",
        ),
        true,
      );
      await previewPanel(`chrome.tabs.remove(${opened.tabId})`);
      await previewPanel("chrome.runtime.sendMessage({type:'remote-chat-clear'})");
    },
  );
  await check(
    'each chat shares the live current page and actions borrow that exact tab without reopening',
    async () => {
      const panel = async (expression) => {
        const response = await cdp(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          sessionId,
        );
        if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
        return response.result.value;
      };
      const userTab = await panel(`chrome.tabs.create({url:${JSON.stringify(url)},active:true})`);
      await eventually(
        async () => (await panel(`chrome.tabs.get(${userTab.id})`)).status === 'complete',
      );
      const originalGroup = await panel(
        `chrome.tabs.group({tabIds:[${userTab.id}],createProperties:{windowId:${userTab.windowId}}})`,
      );
      await panel(
        `chrome.tabGroups.update(${originalGroup},{title:'Owner research',color:'blue'})`,
      );
      const count = (await panel('chrome.tabs.query({})')).length;
      // Send through the real React composer so it captures its own window and active tab.
      await panel(
        `(() => { const input=document.querySelector('#message'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Read this current page'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`,
      );
      await panel("document.querySelector('#send').click()");
      const message = await eventually(() =>
        chatMessages.find((m) => m.text === 'Read this current page'),
      );
      const context = JSON.parse(message.context);
      assert.equal(context.tabId, userTab.id);
      assert.equal(context.status, 'excerpt');
      assert.match(context.text, /Browser actions fixture/);
      assert.equal(
        (await rpc('info')).control,
        null,
        'automatic context does not start an action task',
      );
      assert.equal((await panel('chrome.tabs.query({})')).length, count);
      const selected = await rpc('use-current-tab', { contextId: context.contextId });
      assert.equal(selected.tabId, userTab.id);
      assert.equal(selected.borrowed, true);
      await rpc('fill', { ref: await find('#input'), text: 'Keep this live draft' });
      assert.equal((await state('#input')).value, 'Keep this live draft');
      // A second message uses the same live page while control already exists.
      const next = await panel(
        `chrome.runtime.sendMessage({type:'remote-chat-send',text:'Keep using this page',windowId:${userTab.windowId},tabId:${userTab.id}})`,
      );
      assert.equal(next.ok, true);
      const second = await eventually(() =>
        chatMessages.find((m) => m.text === 'Keep using this page'),
      );
      assert.notEqual(JSON.parse(second.context).contextId, context.contextId);
      const other = await panel(
        `chrome.tabs.create({url:${JSON.stringify(url + 'next')},active:true})`,
      );
      await rpc('use-current-tab', { contextId: JSON.parse(second.context).contextId });
      assert.equal(
        (await state('#input')).value,
        'Keep this live draft',
        'focus changes do not redirect the task',
      );
      await rpc('click', { ref: await find('#click') });
      assert.equal((await state('#click')).text, 'Clicked 1');
      await rpc('stop');
      const kept = await panel(`chrome.tabs.get(${userTab.id})`);
      assert.equal(kept.groupId, originalGroup);
      assert.equal((await panel(`chrome.tabGroups.get(${originalGroup})`)).title, 'Owner research');
      assert.equal((await panel(`chrome.tabs.get(${other.id})`)).active, true);
      await assert.rejects(
        rpc('use-current-tab', { contextId: context.contextId }),
        (e) => e.code === 'STALE_CONTEXT',
      );
      await panel(`chrome.tabs.remove([${userTab.id},${other.id}])`);
    },
  );
  await rpc('open', { url });
  await rpc('wait', { condition: 'loaded' });
  const mainTab = (await rpc('tabs')).tabs.find((t) => t.selected).id;
  const panelPhase = async () =>
    (
      await cdp(
        'Runtime.evaluate',
        {
          expression: "document.querySelector('.live-preview')?.dataset.phase",
          returnByValue: true,
        },
        sessionId,
      )
    ).result.value;
  await check(
    'sidebar shows actual command activity and explicit progress preserves the task',
    async () => {
      await eventually(async () => (await panelPhase()) === 'ready');
      const waiting = rpc('wait', {
        condition: 'visible',
        selector: '#never',
        timeoutMs: 800,
      }).catch((e) => e);
      await eventually(async () => (await panelPhase()) === 'running');
      assert.equal((await waiting).code, 'WAIT_TIMEOUT');
      await eventually(async () => (await panelPhase()) === 'ready');
      await rpc('finish');
      await eventually(async () => (await panelPhase()) === 'finished');
      const reply = await fetch(rpcUrl + '/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Browser fixture progress', final: false }),
      });
      assert.equal((await reply.json()).ok, true);
      assert.equal((await rpc('info')).control.phase, 'finished');
      assert.equal(await panelPhase(), 'finished');
      await rpc('snapshot');
      await eventually(async () => (await panelPhase()) === 'ready');
    },
  );
  await check('a failed C4 delivery is visible in the real sidebar', async () => {
    await cdp(
      'Runtime.evaluate',
      {
        expression:
          "chrome.runtime.sendMessage({type:'remote-chat-send',text:'fixture:fail-delivery'})",
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    await eventually(
      async () =>
        (
          await cdp(
            'Runtime.evaluate',
            {
              expression:
                "!!document.querySelector('.message-delivery[role=alert]') && !document.querySelector('.reply-status')",
              returnByValue: true,
            },
            sessionId,
          )
        ).result.value,
    );
    assert.equal(await panelPhase(), 'ready');
  });
  await check('snapshot includes iframe and Shadow DOM controls', async () => {
    const snapshot = await rpc('snapshot', { interactive: true });
    assert.match(snapshot.text, /Frame button/);
    assert.match(snapshot.text, /Root shadow button/);
  });
  await check('coordinates click canvas and drag pointer controls', async () => {
    await rpc('click', { x: 1150, y: 45 });
    assert.equal((await state('#canvas-result')).text, 'Canvas clicked');
    await rpc('drag', { from: { x: 1050, y: 120 }, to: { x: 1170, y: 120 } });
    assert.equal((await state('#slider')).text, '1170');
    await assert.rejects(
      rpc('click', { x: 99999, y: 99999 }),
      (e) => e.code === 'MOUSE_OUTSIDE_VIEWPORT',
    );
  });
  await check('closed Shadow DOM works through accessibility refs', async () => {
    const snapshot = await rpc('snapshot', { interactive: true });
    const ref = snapshot.text
      .split('\n')
      .find((line) => line.includes('"Closed shadow button"'))
      .split(' ')[0];
    await rpc('click', { ref });
    assert.equal((await rpc('inspect', { ref })).text, 'Closed shadow clicked');
  });
  await check('single, double, right click and hover', async () => {
    await rpc('click', { ref: (await find('#click')).slice(1) });
    assert.equal((await state('#click')).text, 'Clicked 1');
    await rpc('double-click', { ref: await find('#double') });
    assert.equal((await state('#double')).text, 'Double clicked');
    await rpc('right-click', { ref: await find('#right') });
    assert.equal((await state('#right')).text, 'Right clicked');
    await rpc('hover', { ref: await find('#hover') });
    await rpc('wait', { condition: 'visible', selector: '#hover-menu' });
  });
  await check('fill, keyboard shortcut, select, checkbox states', async () => {
    const ref = await find('#input');
    await rpc('fill', { ref, text: 'before' });
    await rpc('keypress', { ref, key: 'a', modifiers: ['Meta'] });
    await rpc('type', { ref, text: 'after' });
    assert.equal((await rpc('inspect', { ref })).value, 'after');
    await rpc('select', { ref: await find('#select'), values: ['b'] });
    assert.equal((await state('#select')).value, 'b');
    const cb = await find('#check');
    await rpc('check', { ref: cb, checked: true });
    await rpc('check', { ref: cb, checked: true });
    assert.equal((await rpc('inspect', { ref: cb })).checked, true);
    await rpc('check', { ref: cb, checked: false });
    assert.equal((await rpc('inspect', { ref: cb })).checked, false);
  });
  await check('targeted container scrolling', async () => {
    const ref = await find('#panel');
    await rpc('scroll', { ref, direction: 'down', pixels: 200 });
    assert.equal((await rpc('inspect', { ref })).scroll.y, 200);
  });
  await check('same-origin, cross-origin iframe and shadow input/click', async () => {
    const { frames } = await rpc('frames');
    console.log('FRAMES', JSON.stringify(frames));
    const embedded = frames.filter((f) => f.url?.includes('/frame'));
    assert.equal(embedded.length, 3);
    for (const frame of embedded) {
      await rpc('click', { ref: await find('#frame-button', frame.id) });
      assert.equal(
        (await rpc('inspect', { ref: await find('#frame-button', frame.id) })).text,
        'Frame clicked',
      );
      await rpc('fill', { ref: await find('#shadow-input', frame.id), text: 'shadow text' });
      assert.equal(
        (await rpc('inspect', { ref: await find('#shadow-input', frame.id) })).value,
        'shadow text',
      );
    }
    await rpc('fill', { ref: await find('#root-shadow-input'), text: 'root shadow' });
    assert.equal((await state('#root-shadow-input')).value, 'root shadow');
  });
  await check('HTML drag and drop', async () => {
    await rpc('drag', { from: { ref: await find('#drag') }, to: { ref: await find('#drop') } });
    assert.equal((await state('#drop')).text, 'Dropped fixture');
  });
  await check('native confirm and prompt can be inspected and handled', async () => {
    try {
      await rpc('click', { ref: await find('#dialog') });
    } catch (e) {
      if (e.code !== 'DIALOG_OPEN') throw e;
    }
    assert.equal((await rpc('dialog')).dialog.type, 'confirm');
    await rpc('dialog', { action: 'accept' });
    assert.equal((await state('#dialog-result')).text, 'Accepted');
    try {
      await rpc('click', { ref: await find('#prompt') });
    } catch (e) {
      if (e.code !== 'DIALOG_OPEN') throw e;
    }
    await rpc('dialog', { action: 'accept', promptText: 'entered' });
    assert.equal((await state('#dialog-result')).text, 'entered');
  });
  await check('wait conditions and bounded timeout', async () => {
    await rpc('wait', { condition: 'text', text: 'Root shadow button' });
    await rpc('wait', { condition: 'checked', selector: '#check', checked: false });
    await rpc('wait', { condition: 'hidden', selector: '#missing' });
    await rpc('click', { ref: await find('#schedule') });
    await rpc('wait', { condition: 'clickable', selector: '#late' });
    await assert.rejects(
      rpc('wait', { condition: 'visible', selector: '#missing', timeoutMs: 200 }),
      (e) => e.code === 'WAIT_TIMEOUT',
    );
  });
  await check('popup joins task and can be selected', async () => {
    await rpc('click', { ref: await find('#popup') });
    const popup = await rpc('wait', { condition: 'new-tab', timeoutMs: 3000 });
    await rpc('switch-tab', { tabId: popup.tabId });
    await rpc('wait', { condition: 'loaded' });
    await rpc('click', { ref: await find('#popup-button') });
    assert.equal((await state('#popup-button')).text, 'Popup clicked');
    await rpc('switch-tab', { tabId: mainTab });
  });
  await check('identical in-flight request IDs execute one mutation', async () => {
    const ref = await find('#click');
    const requestId = crypto.randomUUID();
    const [a, b] = await Promise.all([
      rpc('click', { ref }, { requestId }),
      rpc('click', { ref }, { requestId }),
    ]);
    assert.ok(a.done && b.done);
    // Concurrent HTTP calls can reach the relay in either order.
    assert.equal([a, b].filter((result) => result.replayed === true).length, 1);
    assert.equal((await rpc('click', { ref }, { requestId })).replayed, true);
    assert.equal((await state('#click')).text, 'Clicked 2');
    await assert.rejects(
      rpc('hover', { ref }, { requestId }),
      (e) => e.code === 'REQUEST_ID_CONFLICT',
    );
  });
  await check('navigation back forward reload and URL wait', async () => {
    assert.equal((await rpc('click', { ref: await find('#spa') })).done, true);
    await rpc('wait', { condition: 'url', url: url + 'spa' });
    assert.equal((await state('#spa')).text, 'SPA opened');
    await rpc('back');
    await rpc('wait', { condition: 'url', url });
    assert.equal((await rpc('click', { ref: await find('#next') })).done, true);
    await rpc('wait', { condition: 'url', url: url + 'next' });
    await rpc('back');
    await rpc('wait', { condition: 'url', url });
    await rpc('forward');
    await rpc('wait', { condition: 'url', url: url + 'next' });
    await rpc('reload');
    await rpc('wait', { condition: 'loaded' });
  });
  await check('old refs expire on reload and invalid history is reported', async () => {
    const old = await find('#next');
    await rpc('reload');
    await rpc('wait', { condition: 'loaded' });
    await assert.rejects(rpc('inspect', { ref: old }), (e) => e.code === 'STALE_ELEMENT');
    await assert.rejects(rpc('forward'), (e) => e.code === 'NO_HISTORY_ENTRY');
  });
  await check('offscreen cross-origin frame is scrolled into view before input', async () => {
    await rpc('open', { url: url + 'far-frame' });
    await rpc('wait', { condition: 'loaded' });
    const snapshot = await rpc('snapshot');
    assert.ok(
      !snapshot.text.includes('987654') && !snapshot.text.includes('fixture-password'),
      snapshot.text,
    );
    const otp = await find('#otp');
    assert.equal((await rpc('inspect', { ref: otp })).value, '[redacted]');
    await assert.rejects(
      rpc('fill', { ref: otp, text: 'blocked' }),
      (e) => e.code === 'SENSITIVE_INPUT',
    );
    await rpc('click', { ref: await find('#frame-button') });
    assert.equal((await state('#frame-button')).text, 'Frame clicked');
    await rpc('fill', { ref: await find('#shadow-input'), text: 'offscreen frame' });
    assert.equal((await state('#shadow-input')).value, 'offscreen frame');
  });
  await check('pause interrupts a wait and cancels queued writes', async () => {
    const waiting = rpc('wait', {
      condition: 'visible',
      selector: '#never',
      timeoutMs: 10000,
    }).catch((e) => e);
    await sleep(100);
    const queued = rpc('click', { x: 10, y: 10 }).catch((e) => e);
    await sleep(100);
    await rpc('pause');
    assert.equal((await waiting).code, 'STOPPED');
    assert.equal((await queued).code, 'STOPPED');
    assert.ok((await rpc('tabs')).tabs.length > 0);
  });
  await check(
    'final answer releases control, cancels old commands and hands back open pages',
    async () => {
      await rpc('snapshot');
      const owned = (await rpc('tabs')).tabs.map((tab) => tab.id);
      const waiting = rpc('wait', {
        condition: 'visible',
        selector: '#never',
        timeoutMs: 10000,
      }).catch((e) => e);
      await eventually(async () => (await panelPhase()) === 'running');
      const queued = rpc('click', { x: 10, y: 10 }).catch((e) => e);
      await sleep(100);
      const reply = await fetch(rpcUrl + '/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Final answer; keep the result pages' }),
      });
      assert.equal((await reply.json()).ok, true);
      await eventually(async () => (await rpc('info')).control === null);
      await eventually(async () => (await panelPhase()) === undefined);
      assert.equal((await waiting).code, 'STOPPED');
      assert.equal((await queued).code, 'STOPPED');
      await eventually(async () => {
        const browser = (
          await cdp(
            'Runtime.evaluate',
            {
              expression: `(async () => ({
          tabs: await chrome.tabs.query({}),
          targets: await chrome.debugger.getTargets(),
          badge: await chrome.action.getBadgeText({}),
          reply: document.querySelector('#history').textContent.includes('Final answer; keep the result pages'),
          waiting: !!document.querySelector('.reply-status')
        }))()`,
              awaitPromise: true,
              returnByValue: true,
            },
            sessionId,
          )
        ).result.value;
        return (
          browser.reply &&
          !browser.waiting &&
          browser.badge === '' &&
          owned.every((id) => browser.tabs.some((tab) => tab.id === id && tab.groupId === -1)) &&
          !browser.targets.some((target) => owned.includes(target.tabId) && target.attached)
        );
      });
    },
  );
  await check(
    'a final reply queued while disconnected is delivered on reconnect and removes the task',
    async () => {
      await rpc('open', { url });
      await rpc('wait', { condition: 'loaded' });
      const owned = (await rpc('tabs')).tabs.map((tab) => tab.id);
      const keyId = relay.ext.connectedIds()[0];
      const waiting = rpc('wait', {
        condition: 'visible',
        selector: '#never',
        timeoutMs: 10000,
      }).catch((e) => e);
      await eventually(async () => (await panelPhase()) === 'running');
      relay.ext.conns.get(keyId).ws.terminate();
      await eventually(() => !relay.ext.isConnected(keyId));
      assert.equal((await waiting).code, 'EXT_OFFLINE');
      const response = await fetch(rpcUrl + '/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: keyId, text: 'Recovered final answer after disconnect' }),
      });
      const receipt = await response.json();
      assert.equal(response.status, 202);
      assert.equal(receipt.queued, true);
      await eventually(
        async () => relay.ext.isConnected(keyId) && !relay.ext.outbox.first(keyId),
        15000,
      );
      assert.equal((await rpc('info')).control, null);
      assert.equal(await panelPhase(), undefined);
      const page = (
        await cdp(
          'Runtime.evaluate',
          {
            expression: `(async () => ({ tabs: await chrome.tabs.query({}), replies: [...document.querySelectorAll('.message-text')].filter((el) => el.textContent === 'Recovered final answer after disconnect').length }))()`,
            awaitPromise: true,
            returnByValue: true,
          },
          sessionId,
        )
      ).result.value;
      assert.equal(page.replies, 1);
      assert.ok(owned.every((id) => page.tabs.some((tab) => tab.id === id && tab.groupId === -1)));
    },
  );
  await check('sidebar stop button revokes control and cleans task tabs', async () => {
    await rpc('open', { url });
    await rpc('wait', { condition: 'loaded' });
    const owned = (await rpc('tabs')).tabs.map((tab) => tab.id);
    await eventually(
      async () =>
        (
          await cdp(
            'Runtime.evaluate',
            {
              expression: "!!document.querySelector('#stop-task')",
              returnByValue: true,
            },
            sessionId,
          )
        ).result.value,
    );
    await cdp(
      'Runtime.evaluate',
      {
        expression: "document.querySelector('#stop-task').click()",
      },
      sessionId,
    );
    await eventually(async () => (await rpc('info')).control === null);
    await eventually(async () => {
      const tabs = await cdp(
        'Runtime.evaluate',
        {
          expression: 'chrome.tabs.query({})',
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      );
      return !tabs.result.value.some((tab) => owned.includes(tab.id));
    });
  });
  // Negotiate the new mode over a fresh real connection. The preceding checks
  // exercise legacy compatibility; the following ones use only model decisions.
  relay.ext.agentLoop = true;
  await previewPanel("chrome.runtime.sendMessage({type:'remote-set-enabled',enabled:false})");
  await previewPanel("chrome.runtime.sendMessage({type:'remote-set-enabled',enabled:true})");
  await eventually(() => relay.ext.connectedIds().length > 0);
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
    await decision(request, { kind: 'done', text });
    await eventually(
      async () =>
        !(await previewPanel("chrome.runtime.sendMessage({type:'remote-state'})")).value.loopActive,
    );
    assert.equal((await rpc('info')).control, null);
  };
  await check(
    'extension loop answers ordinary chat without opening or controlling tabs',
    async () => {
      const before = (await previewPanel('chrome.tabs.query({})')).map((tab) => tab.id);
      const request = await askLoop('Loop: just say hello');
      assert.equal(request.request.payload.protocol, 'browser-decision-v1');
      assert.equal(
        request.request.payload.tools.length,
        2,
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
      await assert.rejects(
        rpc('click', { x: 10, y: 10 }),
        (error) => error.code === 'LOOP_OWNS_BROWSER',
      );
      const legacy = await fetch(rpcUrl + '/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'wrong reply route' }),
      });
      assert.equal((await legacy.json()).code, 'DECISION_REQUIRED');
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
      assert.equal((await rpc('info')).control, null);
      assert.ok(await previewPanel(`chrome.tabs.get(${tab.id})`), 'borrowed tab remains open');
    },
  );
  console.log(
    JSON.stringify(
      { passed: checks.length, checks, browser: await cdp('Browser.getVersion') },
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
