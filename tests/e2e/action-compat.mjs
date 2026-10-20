import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
const root = '/home/owen/zylos/workspace/browser-focus-harness';
const profile = await fs.mkdtemp('/tmp/coco-focus-local-');
process.env.BROWSER_REMOTE_KEY = 'cd'.repeat(32);
process.env.BROWSER_REMOTE_OBS_DIR = path.join(profile, 'observations');
const { start } = await import(
  process.env.FOCUS_REMOTE || '/home/owen/zylos/workspace/browser-main-repro-remote/src/index.js'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  let error;
  while (Date.now() < end) {
    try {
      const x = await fn();
      if (x) return x;
    } catch (e) {
      error = e;
    }
    await sleep(100);
  }
  throw error || Error('timed out');
}
let browser, relay, site, ws, display;
const rows = [],
  events = [],
  messages = [];
const provenance = {};
const out =
  process.env.FOCUS_OUT || '/home/owen/zylos/workspace/browser-action-compat-e2e-results.json';
try {
  site = http.createServer(async (req, res) => {
    if (req.url === '/react-fixture.js') {
      res.setHeader('content-type', 'application/javascript');
      res.end(await fs.readFile(path.join(root, 'fixture-dist/react-fixture.js')));
      return;
    }
    const mode = new URL(req.url, 'http://local').searchParams.get('mode') || 'plain';
    if (mode.startsWith('compat-')) {
      res.setHeader('content-type', 'text/html');
      const child =
        mode === 'compat-same-frame' || mode === 'compat-oopif' || mode === 'compat-child-race';
      const field =
        mode === 'compat-textarea'
          ? '<textarea id="field">OLD</textarea>'
          : mode === 'compat-editor'
            ? '<div contenteditable="true" id="field"><b>OLD</b></div>'
            : mode === 'compat-shadow'
              ? '<div id="host"></div>'
              : '<input id="field" value="OLD">';
      res.end(
        '<!doctype html><title>Compatibility ' +
          mode +
          '</title><p>MAIN_MARKER</p><input id="other" value="UNTOUCHED">' +
          (child
            ? '<iframe id="child" src="http://' +
              (mode === 'compat-same-frame' ? '127.0.0.1' : 'localhost') +
              ':' +
              site.address().port +
              '/?mode=compat-plain"></iframe>'
            : field) +
          '<script>globalThis.inputs=0;document.addEventListener("input",()=>inputs++);' +
          (mode === 'compat-shadow'
            ? 'document.querySelector("#host").attachShadow({mode:"open"}).innerHTML=\'<input id="field" value="OLD">\';'
            : '') +
          '</script>',
      );
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (['frame-remove', 'frame-navigate', 'frame-reparent'].includes(mode)) {
      res.end(
        `<!doctype html><title>${mode}</title><p>Outer frame fixture</p><div id="a"><iframe id="inner" style="width:600px;height:240px" src="http://localhost:${site.address().port}/?mode=focus-child&parentmode=${mode}"></iframe></div><div id="b"></div><script>addEventListener('message',e=>{if(e.data!=='fixture-focus')return;const f=document.querySelector('#inner');if(${JSON.stringify(mode)}==='frame-remove')f.remove();if(${JSON.stringify(mode)}==='frame-reparent')document.querySelector('#b').append(f);});</script>`,
      );
      return;
    }
    if (mode === 'shadow-replace') {
      res.end(
        '<!doctype html><title>Shadow replacement</title><div id="host"></div><script>const root=document.querySelector("#host").attachShadow({mode:"open"});root.innerHTML="<input id=field aria-label=Tunnel-name style=padding:20px>";root.querySelector("input").onfocus=function(){const n=this.cloneNode(true);this.replaceWith(n);};</script>',
      );
      return;
    }
    if (mode === 'react') {
      res.end(
        '<!doctype html><title>React controlled input</title><style>body{padding:40px}input{padding:12px}</style><div id="react"></div><script src="/react-fixture.js"></script>',
      );
      return;
    }
    res.end(`<!doctype html><title>Focus ${mode}</title><style>body{padding:40px;font:18px sans-serif}input,button{padding:12px;margin:15px}iframe{width:250px;height:70px}</style><button onclick="this.textContent='Button done'">Control button</button><input id="field" aria-label="Tunnel name"><p id="proof">Initial</p><script>
  const mode=${JSON.stringify(mode)};let ran=false;
  document.querySelector('#field').addEventListener('focus',function(){
   document.querySelector('#proof').textContent='Focused';if(ran)return;ran=true;
   if(mode==='replace'){const n=this.cloneNode(true);this.replaceWith(n);}
   if(mode==='blur')this.blur();
   if(mode==='iframe'){const f=document.createElement('iframe');f.src='http://localhost:${site.address().port}/?mode=child';document.body.append(f);}
   if(mode==='extframe'){const f=document.createElement('iframe');f.src='chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/frame.html';document.body.append(f);}
   if(mode==='navigate')location.href='/?mode=destination';
   if(mode==='popup')window.open('/?mode=destination','_blank');
   if(mode==='exception')throw new Error('Synthetic focus handler failure');
   if(mode==='dialog')alert('Local focus dialog');
   if(mode==='focus-child'){parent.postMessage('fixture-focus','*');if(new URL(location.href).searchParams.get('parentmode')==='frame-navigate')location.href='http://127.0.0.1:${site.address().port}/?mode=destination';}
  });document.querySelector('#field').addEventListener('input',function(){document.querySelector('#proof').textContent='Input:'+this.value;if(mode==='controlled'){this.value=this.value.toUpperCase();}});
  if(mode==='datalist'){const list=document.createElement('datalist');list.id='suggest';list.innerHTML='<option value="probe-one"><option value="probe-two">';document.body.append(list);document.querySelector('#field').setAttribute('list','suggest');}
  </script>`);
  });
  site.listen(0, '0.0.0.0');
  await once(site, 'listening');
  relay = await start({
    extPort: 0,
    agentPort: 0,
    monitor: true,
    monitorFile: path.join(profile, 'monitor.json'),
    agentMonitorDir: null,
    activityEnabled: false,
    onStop: async () => ({ ok: true }),
    onRequest: async (m) => {
      messages.push(m);
      return { ok: true };
    },
  });
  relay.ext.on('agent-event', (e) => events.push(e));
  relay.ext.on('agent-turn-end', (e) => events.push({ type: 'end', ...e }));
  const rpc = `http://127.0.0.1:${relay.agent.server.address().port}`;
  const relayUrl = `ws://127.0.0.1:${relay.ext.server.address().port}/ext`;
  const extension =
    process.env.FOCUS_EXTENSION ||
    '/home/owen/zylos/workspace/browser-action-compat/.output/chrome-mv3';
  Object.assign(provenance, {
    extension,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(extension, '../..'),
      encoding: 'utf8',
    }).trim(),
    trackedChanges: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: path.resolve(extension, '../..'),
      encoding: 'utf8',
    }).trim(),
    backgroundSha256: createHash('sha256')
      .update(await fs.readFile(extension + '/background.js'))
      .digest('hex'),
  });
  display = spawn(
    '/usr/bin/Xtigervnc',
    [':110', '-localhost', '-SecurityTypes', 'None', '-rfbport', '6110', '-geometry', '1280x900'],
    { stdio: 'ignore' },
  );
  await sleep(800);
  browser = spawn(
    '/usr/bin/google-chrome',
    [
      '--no-sandbox',
      '--no-first-run',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--user-data-dir=' + profile,
      '--remote-debugging-port=0',
      '--window-size=1280,900',
      '--site-per-process',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, DISPLAY: ':110' } },
  );
  let stderr = '';
  browser.stderr.on('data', (x) => (stderr += x));
  const address = await until(async () => {
    const p = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'))
      .trim()
      .split('\n');
    return `ws://127.0.0.1:${p[0]}${p[1]}`;
  });
  ws = new WebSocket(address);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.t);
      m.error ? p.j(Error(m.error.message)) : p.r(m.result);
    }
  };
  const cdp = (method, params = {}, sessionId) =>
    new Promise((r, j) => {
      const id = ++seq;
      const t = setTimeout(() => {
        pending.delete(id);
        j(Error('CDP timeout ' + method));
      }, 10000);
      pending.set(id, { r, j, t });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const management = await cdp('Target.createTarget', { url: 'chrome://extensions/' });
  const { sessionId: managementSession } = await cdp('Target.attachToTarget', {
    targetId: management.targetId,
    flatten: true,
  });
  await until(
    async () =>
      (
        await cdp(
          'Runtime.evaluate',
          { expression: '!!chrome.developerPrivate', returnByValue: true },
          managementSession,
        )
      ).result.value,
  );
  for (const loadPath of process.env.FOCUS_NO_AUX === '1'
    ? [extension]
    : ['/home/owen/zylos/workspace/browser-main-repro-aux', extension]) {
    await cdp(
      'Runtime.evaluate',
      {
        expression:
          'chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true});chrome.developerPrivate.loadUnpacked({failQuietly:true},()=>{globalThis.loadError=chrome.runtime.lastError?.message||"ok"});',
      },
      managementSession,
    );
    await sleep(1500);
    for (const args of [
      ['key', 'ctrl+l'],
      ['type', '--clearmodifiers', loadPath + '/'],
      ['key', 'Return'],
      ['key', 'alt+o'],
    ]) {
      execFileSync('/usr/bin/xdotool', args, { env: { ...process.env, DISPLAY: ':110' } });
      await sleep(700);
    }
  }
  const worker = await until(
    async () =>
      (await cdp('Target.getTargets')).targetInfos.find(
        (t) => t.type === 'service_worker' && t.url.endsWith('/background.js'),
      ),
    20000,
  );
  const extensionId = new URL(worker.url).host;
  const { targetId } = await cdp('Target.createTarget', {
    url: `chrome-extension://${extensionId}/sidepanel.html`,
  });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const { sessionId: workerSession } = await cdp('Target.attachToTarget', {
    targetId: worker.targetId,
    flatten: true,
  });
  async function evaluate(expression, session = sessionId) {
    const r = await cdp(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      session,
    );
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  await until(() => evaluate('!!globalThis.chrome?.runtime?.sendMessage'));
  await evaluate(
    `chrome.runtime.sendMessage({type:'remote-save',relayUrl:${JSON.stringify(relayUrl)},key:${JSON.stringify(process.env.BROWSER_REMOTE_KEY)}})`,
  );
  const state = async () =>
    (await evaluate("chrome.runtime.sendMessage({type:'remote-state'})")).value;
  await until(async () => (await state()).connected);
  await evaluate(
    `globalThis.detachEvents=[];globalThis.frameEvents=[];chrome.debugger.onDetach.addListener((source,reason)=>detachEvents.push({at:Date.now(),source,reason}));chrome.debugger.onEvent.addListener((source,method,params)=>{if(['Target.attachedToTarget','Target.detachedFromTarget','Page.frameNavigated'].includes(method))frameEvents.push({at:Date.now(),source,method,params});});`,
    workerSession,
  );
  await evaluate(
    `globalThis.cdpErrors=[];globalThis.cdpCommands=[];const originalAttach=chrome.debugger.attach.bind(chrome.debugger);chrome.debugger.attach=async(target,version)=>{cdpCommands.push({at:Date.now(),target,method:'Debugger.attach'});return originalAttach(target,version)};const original=chrome.debugger.sendCommand.bind(chrome.debugger);chrome.debugger.sendCommand=async function(target,method,params){const started=Date.now();cdpCommands.push({at:started,target,method});try{
 if(method==='Runtime.callFunctionOn'&&['commit-input','check-focus'].includes(params?.arguments?.[0]?.value)&&!globalThis.compatMutated&&['compat-selection','compat-readonly','compat-focus','compat-replace'].includes(globalThis.compatMode)){
  globalThis.compatMutated=true;
  await original(target,'Runtime.callFunctionOn',{objectId:params.objectId,functionDeclaration:'function(mode){if(mode==="compat-selection")this.setSelectionRange(1,1);if(mode==="compat-readonly")this.readOnly=true;if(mode==="compat-focus")document.querySelector("#other").focus();if(mode==="compat-replace")this.replaceWith(this.cloneNode(true));}',arguments:[{value:globalThis.compatMode}],returnByValue:true});
 }
 if(globalThis.compatMode==='compat-child-race'&&target.sessionId&&method==='DOMSnapshot.captureSnapshot'){globalThis.compatMutated=true;return {documents:[],strings:[]};}
 return await original(target,method,params);
 }catch(e){cdpErrors.push({at:Date.now(),started,target,method,name:e.name,message:e.message,stack:e.stack});throw e;}}`,
    workerSession,
  );
  const base = `http://127.0.0.1:${site.address().port}/`;
  provenance.browser = await cdp('Browser.getVersion');
  provenance.remoteSource =
    process.env.FOCUS_REMOTE || '/home/owen/zylos/workspace/browser-main-repro-remote/src/index.js';
  provenance.remoteCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.dirname(provenance.remoteSource),
    encoding: 'utf8',
  }).trim();
  console.log(
    JSON.stringify({
      phase: 'ready',
      base,
      profile,
      browser: await cdp('Browser.getVersion'),
      extensionId,
    }),
  );
  const decide = async (request, decision) => {
    const response = await fetch(rpc + '/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: request.endpointId, id: request.id, decision }),
      signal: AbortSignal.timeout(20000),
    });
    return response.json();
  };
  for (const mode of (
    process.env.FOCUS_MODES ||
    'compat-plain,compat-textarea,compat-editor,compat-shadow,compat-same-frame,compat-oopif,compat-selection,compat-readonly,compat-focus,compat-replace,compat-child-race,auxframe'
  ).split(','))
    for (const method of process.env.FOCUS_METHODS?.split(',') || [
      mode === 'compat-child-race' ? 'wait-for-page' : 'fill',
    ]) {
      const started = Date.now(),
        eventStart = events.length;
      try {
        const fixtureMode = mode.startsWith('recovery-') ? 'auxframe' : mode;
        const tab = await evaluate(
          `chrome.tabs.create({url:${JSON.stringify(base + '?mode=' + fixtureMode)},active:true})`,
        );
        await until(
          async () => (await evaluate(`chrome.tabs.get(${tab.id})`)).status === 'complete',
        );
        const text = `fixture-${mode}-${method}-${started}`;
        const reply = await evaluate(
          `chrome.runtime.sendMessage(${JSON.stringify({ type: 'remote-chat-send', message: { role: 'user', content: [{ type: 'text', text }] }, tabId: tab.id, windowId: tab.windowId })})`,
        );
        if (!reply.ok) throw Error(JSON.stringify(reply));
        const initial = await until(() => messages.find((m) => m.text === text && m.request));
        let request = { ...initial.request, endpointId: initial.endpointId };
        let result = await decide(request, {
          kind: 'actions',
          actions: [
            {
              method: 'use-current-tab',
              params: { contextId: request.context.pages[0].contextId },
            },
          ],
        });
        if (!result.next) throw Error('initial control ' + JSON.stringify(result));
        request = result.next;
        result = await decide(request, {
          kind: 'actions',
          actions: [
            { method: 'find', params: { selector: mode === 'button' ? 'button' : '#field' } },
          ],
        });
        if (!result.next) throw Error('find ' + JSON.stringify(result));
        request = result.next;
        const ref = request.execution.observation.page.matches[0].ref;
        await evaluate(
          `globalThis.compatMode=${JSON.stringify(mode)};globalThis.compatMutated=false;`,
          workerSession,
        );
        const targetsBefore = (await cdp('Target.getTargets')).targetInfos
          .filter((t) => t.url === base + '?mode=' + mode)
          .map((t) => ({ targetId: t.targetId, type: t.type, url: t.url }));
        if (mode === 'detach')
          await evaluate(
            `setTimeout(()=>chrome.debugger.detach({tabId:${tab.id}}),100)`,
            workerSession,
          );
        if (mode === 'close')
          await evaluate(`setTimeout(()=>chrome.tabs.remove(${tab.id}),100)`, workerSession);
        if (mode === 'devtools')
          setTimeout(
            () =>
              execFileSync('/usr/bin/xdotool', ['key', 'ctrl+shift+i'], {
                env: { ...process.env, DISPLAY: ':110' },
              }),
            100,
          );
        result = await decide(request, {
          kind: 'actions',
          actions: [
            {
              method,
              params:
                method === 'fill'
                  ? { ref, text: 'probe-value' }
                  : method === 'wait-for-page'
                    ? {}
                    : { ref },
            },
          ],
        });
        if (mode === 'dialog')
          await evaluate(
            `chrome.debugger.sendCommand({tabId:${tab.id}},'Page.handleJavaScriptDialog',{accept:false}).catch(e=>({error:e.message}))`,
            workerSession,
          );
        const detached = await evaluate('detachEvents', workerSession);
        const frames = await evaluate('frameEvents', workerSession);
        const tabAfter = await evaluate(`chrome.tabs.get(${tab.id}).catch(e=>({error:e.message}))`);
        const pageAfter = await evaluate(
          `chrome.scripting.executeScript({target:{tabId:${tab.id},allFrames:true},world:'MAIN',func:()=>{const field=document.querySelector('#field')||document.querySelector('#host')?.shadowRoot?.querySelector('#field');return {url:location.href,value:field?.value??field?.textContent,other:document.querySelector('#other')?.value,inputs:globalThis.inputs,proof:document.querySelector('#proof')?.textContent,frames:[...document.querySelectorAll('iframe')].map(f=>f.src)}}}).catch(e=>({error:e.message}))`,
        );
        const connected = (await state()).connected;
        const targetsAfter = (await cdp('Target.getTargets')).targetInfos
          .filter((t) => t.url === base + '?mode=' + mode)
          .map((t) => ({ targetId: t.targetId, type: t.type, url: t.url }));
        const nativeErrors = (await evaluate('cdpErrors', workerSession)).filter(
          (x) => x.at >= started,
        );
        const nativeCommands = (await evaluate('cdpCommands', workerSession)).filter(
          (x) => x.at >= started,
        );
        const insertCalls = nativeCommands.filter(
          (command) => command.method === 'Input.insertText',
        ).length;
        rows.push({
          mode,
          method,
          insertCalls,
          durationMs: Date.now() - started,
          result,
          connected,
          targetsBefore,
          targetsAfter,
          tabAfter,
          pageAfter,
          nativeErrors,
          nativeCommands,
          frameEvents: frames.filter((x) => x.at >= started),
          detached: detached.filter((x) => x.at >= started),
          events: events.slice(eventStart),
        });
        if (mode.startsWith('recovery-')) {
          assert.equal(result.next?.execution?.mode, 'recovery', JSON.stringify(result));
          const recovery = result.next.execution.recovery;
          assert.deepEqual(
            result.next.execution.tools.map((tool) => tool.name),
            ['recover-control'],
          );
          assert.equal(recovery.reason, 'target_closed');
          assert.equal(recovery.cause, 'unknown');
          assert.ok(recovery.expiresAt > Date.now());
          assert.ok(insertCalls <= 1);
          const requestToRecover = result.next;
          const commandsBefore = (await evaluate('cdpCommands', workerSession)).length;
          if (mode === 'recovery-remove') {
            const connection = relay.ext.conns.get(requestToRecover.endpointId);
            connection.ws.terminate();
            await sleep(1500);
            await until(async () => (await state()).connected);
            assert.notEqual(relay.ext.conns.get(requestToRecover.endpointId), connection);
            const resumed = relay.agent.exchange.states.get(requestToRecover.endpointId).next;
            assert.equal(resumed.id, requestToRecover.id);
            assert.deepEqual(resumed.execution.recovery, recovery);
            rows.at(-1).transportResume = {
              samePendingRequest: true,
              unchangedRecoveryId: recovery.recoveryId,
              unchangedExpiresAt: recovery.expiresAt,
            };
            await evaluate(
              `chrome.scripting.executeScript({target:{tabId:${tab.id}},world:'MAIN',func:()=>document.querySelector('#aux')?.remove()})`,
            );
          }
          if (mode === 'recovery-expired')
            await evaluate(
              'globalThis.originalCompatNow=Date.now;Date.now=()=>originalCompatNow()+121000;true',
              workerSession,
            );
          if (mode === 'recovery-stop')
            await evaluate("chrome.runtime.sendMessage({type:'remote-stop'})");
          result = await decide(requestToRecover, {
            kind: 'actions',
            actions: [{ method: 'recover-control', params: { recoveryId: recovery.recoveryId } }],
          });
          if (mode === 'recovery-expired')
            await evaluate('Date.now=originalCompatNow;true', workerSession);
          const commandsAfter = (await evaluate('cdpCommands', workerSession)).slice(
            commandsBefore,
          );
          assert.equal(
            commandsAfter.filter((command) => command.method === 'Input.insertText').length,
            0,
            'recovery never replays input',
          );
          rows.at(-1).recovery = { descriptor: recovery, result, commandsAfter };
          if (mode === 'recovery-remove') {
            assert.ok(
              result.next && result.next.execution.mode !== 'recovery',
              JSON.stringify(result),
            );
            assert.ok(result.next.execution.observation.page.text);
            assert.ok(
              !result.next.execution.observation.page.text.includes(ref),
              'fresh refs after recovery',
            );
          } else {
            assert.ok(!result.next, JSON.stringify(result));
            if (mode === 'recovery-expired' || mode === 'recovery-stop')
              assert.equal(
                commandsAfter.filter(
                  (command) =>
                    command.method === 'Debugger.attach' || command.method === 'Input.insertText',
                ).length,
                0,
                'stopped/expired recovery executes no debugger command',
              );
          }
        } else if (mode === 'compat-child-race') {
          assert.equal(await evaluate('compatMutated', workerSession), true);
          assert.ok(result.next && !result.next.execution.failed, JSON.stringify(result));
          assert.equal(result.next.execution.observation.page.partial, true);
          assert.ok(result.next.execution.observation.page.warnings.length > 0);
          assert.ok(result.next.execution.observation.page.text.includes('MAIN_MARKER'));
          assert.equal(insertCalls, 0);
        } else if (mode.startsWith('compat-')) {
          const denied = ['compat-readonly', 'compat-focus', 'compat-replace'].includes(mode);
          assert.equal(insertCalls, denied ? 0 : 1, 'native insertion count ' + mode);
          assert.equal(
            pageAfter.reduce((sum, row) => sum + (row.result?.inputs || 0), 0),
            denied ? 0 : 1,
            'page input-event count ' + mode,
          );
          assert.ok(result.next, 'ordinary fixture must retain control ' + mode);
          if (denied) assert.equal(result.next.execution.failed, true);
          else {
            assert.equal(result.next.execution.failed, false);
            assert.ok(
              pageAfter.some((row) => row.result?.value === 'probe-value'),
              'exact resulting value ' + JSON.stringify(pageAfter),
            );
          }
          assert.ok(
            pageAfter.every((row) => !row.result?.other || row.result.other === 'UNTOUCHED'),
            'other field unchanged',
          );
          if (mode === 'compat-selection' || denied)
            assert.equal(await evaluate('compatMutated', workerSession), true);
        } else if (mode === 'auxframe') {
          assert.equal(result.finished, true);
          assert.equal(result.status, 'interrupted');
          assert.ok(insertCalls <= 1);
          assert.ok(
            detached.some((event) => event.at >= started && event.reason === 'target_closed'),
          );
        }
        console.log(
          JSON.stringify({
            mode,
            method,
            finished: result.finished,
            status: result.status,
            failed: result.next?.execution?.failed,
            results: result.next?.execution?.results,
            connected,
          }),
        );
        if (result.next)
          await decide(result.next, { kind: 'done', text: 'Local fixture complete' });
        await until(async () => !(await state()).chatBusy);
        await evaluate(`chrome.tabs.remove(${tab.id}).catch(()=>{})`);
      } catch (error) {
        rows.push({ mode, method, error: error.message, events: events.slice(eventStart) });
        console.log(JSON.stringify({ mode, method, error: error.message }));
        throw error;
      }
      await fs.writeFile(out, JSON.stringify({ base, profile, provenance, rows }, null, 2));
    }
} catch (error) {
  console.error(error.stack);
  await fs.writeFile(
    out,
    JSON.stringify({ profile, provenance, rows, error: error.message }, null, 2),
  );
  process.exitCode = 1;
} finally {
  ws?.close();
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    await Promise.race([once(browser, 'exit'), sleep(3000)]);
  }
  if (display && display.exitCode === null) {
    display.kill('SIGTERM');
    await Promise.race([once(display, 'exit'), sleep(2000)]);
  }
  relay?.close();
  if (site) await new Promise((r) => site.close(r));
}
