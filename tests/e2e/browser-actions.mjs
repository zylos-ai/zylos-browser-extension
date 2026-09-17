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
const { start } = require(path.join(relayRoot, 'relay/server.js'));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'coco-actions-e2e-'));
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
<a id="popup" href="/popup" target="_blank">Open popup</a><a id="next" href="/next">Next</a>
<a id="spa" href="/spa" onclick="event.preventDefault();history.pushState({},'',this.href);this.textContent='SPA opened'">Open SPA</a>
<iframe title="Same origin" src="/frame"></iframe><iframe title="Cross origin" src="http://localhost:${port}/frame"></iframe>
<iframe title="Nested scaled" style="transform:scale(.9);transform-origin:top left;height:200px" src="/nested"></iframe><div id="shadow"></div><div id="closed"></div><script>const closed=document.querySelector('#closed').attachShadow({mode:'closed'});closed.innerHTML='<button>Closed shadow button</button>';closed.querySelector('button').onclick=()=>closed.querySelector('button').textContent='Closed shadow clicked';const r=document.querySelector('#shadow').attachShadow({mode:'open'});r.innerHTML='<input id="root-shadow-input" aria-label="Root shadow input"><button id="root-shadow-button">Root shadow button</button>';r.querySelector('button').onclick=()=>r.querySelector('button').textContent='Root shadow clicked';</script>`;
}
try {
  site = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(fixture(req.url, site.address().port));
  });
  await new Promise((resolve) => site.listen(0, resolve));
  const url = `http://127.0.0.1:${site.address().port}/`;
  relay = await start({
    extPort: 0,
    agentPort: 0,
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
    'inline tool steps show queued/running/results, collapse on final reply, and survive panel reload',
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
      await rpc('snapshot');
      const waiting = rpc('wait', {
        condition: 'visible',
        selector: '#never',
        timeoutMs: 4000,
      }).catch((e) => e);
      await eventually(() => panel("!!document.querySelector('.tool-step[data-status=running]')"));
      const queued = rpc('find', { selector: '#click' });
      await eventually(() => panel("!!document.querySelector('.tool-step[data-status=queued]')"));
      assert.equal(
        await panel(
          "document.querySelector('.tool-activity-toggle').getAttribute('aria-expanded')",
        ),
        'true',
      );
      assert.equal(
        await panel(
          "getComputedStyle(document.querySelector('.tool-activity-body')).display === 'none'",
        ),
        false,
      );
      assert.equal(await panel('document.documentElement.scrollWidth > innerWidth'), false);
      await screenshot('steps-live');
      assert.equal((await waiting).code, 'WAIT_TIMEOUT');
      await queued;
      await eventually(() =>
        panel(
          "document.querySelector('.tool-step[data-status=error]')?.textContent.includes('WAIT_TIMEOUT')",
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
        ['open', 'snapshot', 'wait', 'find'],
      );
      await screenshot('steps-expanded');
      await cdp('Page.reload', {}, sessionId);
      await eventually(() =>
        panel(
          "document.querySelector('.tool-activity-toggle')?.getAttribute('aria-expanded') === 'false'",
        ),
      );
      assert.equal(await panel("document.querySelectorAll('.tool-step').length"), 4);
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
