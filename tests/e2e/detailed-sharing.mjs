// Isolated local Chrome + TLS + actual sibling Remote. Never uses a user profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const profile = await fs.mkdtemp('/tmp/coco-share-e2e-');
const evidenceDir = process.env.SHARE_EVIDENCE_DIR || profile;
await fs.mkdir(evidenceDir, { recursive: true });
process.env.BROWSER_REMOTE_KEY = 'ac'.repeat(32);
process.env.BROWSER_REMOTE_OBS_DIR = profile + '/observations';
const { start } = await import(
  process.env.SHARE_REMOTE || '../../../zylos-browser-remote/src/index.js'
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  const end = Date.now() + 30000;
  let last;
  while (Date.now() < end) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await sleep(100);
  }
  throw last || Error('Timed out');
}
let relay, tls, browser, display, socket, site;
const requests = [];
const evidence = { checks: [], profile };
try {
  evidence.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  evidence.sourceTrackedChanges = execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=no'],
    { cwd: root, encoding: 'utf8' },
  ).trim();
  evidence.backgroundSha256 = createHash('sha256')
    .update(await fs.readFile(root + '.output/chrome-mv3/background.js'))
    .digest('hex');
  const remoteRoot = fileURLToPath(
    new URL(
      '../',
      new URL(
        process.env.SHARE_REMOTE || '../../../zylos-browser-remote/src/index.js',
        import.meta.url,
      ),
    ),
  );
  evidence.remoteSourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: remoteRoot,
    encoding: 'utf8',
  }).trim();
  evidence.remoteTrackedChanges = execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=no'],
    { cwd: remoteRoot, encoding: 'utf8' },
  ).trim();
  relay = await start({
    extPort: 0,
    agentPort: 0,
    monitor: false,
    activityEnabled: false,
    onRequest: async (message) => {
      requests.push(message);
      return { ok: true };
    },
  });
  site = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      '<!doctype html><title>Local incident fixture</title><input id="field" aria-label="Fixture field">',
    );
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  const auxiliary = profile + '/auxiliary';
  await fs.mkdir(auxiliary);
  await fs.writeFile(
    auxiliary + '/manifest.json',
    JSON.stringify({
      manifest_version: 3,
      name: 'Isolated incident fixture',
      version: '1.0.0',
      content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['inject.js'] }],
      web_accessible_resources: [{ resources: ['frame.html'], matches: ['http://127.0.0.1/*'] }],
    }),
  );
  await fs.writeFile(
    auxiliary + '/frame.html',
    '<!doctype html><title>Foreign frame fixture</title>',
  );
  await fs.writeFile(
    auxiliary + '/inject.js',
    `if(new URL(location.href).searchParams.get('mode')==='foreigniframe')document.addEventListener('focusin',event=>{if(event.target.id!=='field'||document.querySelector('#fixture-frame'))return;const frame=document.createElement('iframe');frame.id='fixture-frame';frame.src=chrome.runtime.getURL('frame.html');document.body.append(frame);});`,
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      profile + '/key.pem',
      '-out',
      profile + '/cert.pem',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ],
    { stdio: 'ignore' },
  );
  tls = https.createServer({
    key: await fs.readFile(profile + '/key.pem'),
    cert: await fs.readFile(profile + '/cert.pem'),
  });
  tls.on('upgrade', relay.ext._onUpgrade.bind(relay.ext));
  tls.listen(0, '127.0.0.1');
  await once(tls, 'listening');
  const relayUrl = `wss://127.0.0.1:${tls.address().port}/ext`;
  const rpc = `http://127.0.0.1:${relay.agent.server.address().port}`;
  const displayName = ':109';
  display = spawn(
    '/usr/bin/Xtigervnc',
    [
      displayName,
      '-localhost',
      '-SecurityTypes',
      'None',
      '-rfbport',
      '6109',
      '-geometry',
      '1280x900',
    ],
    { stdio: 'ignore' },
  );
  await sleep(800);
  browser = spawn(
    '/usr/bin/google-chrome',
    [
      '--no-sandbox',
      '--no-first-run',
      '--ignore-certificate-errors',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--user-data-dir=' + profile,
      '--remote-debugging-port=0',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore', env: { ...process.env, DISPLAY: displayName } },
  );
  const address = await until(async () => {
    const lines = (await fs.readFile(profile + '/DevToolsActivePort', 'utf8')).trim().split('\n');
    return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
  });
  socket = new WebSocket(address);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data),
      waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    message.error ? waiter.reject(Error(message.error.message)) : waiter.resolve(message.result);
  };
  const cdp = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(Error('CDP timeout ' + method));
        }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  evidence.browser = await cdp('Browser.getVersion');
  const manager = await cdp('Target.createTarget', { url: 'chrome://extensions/' });
  const { sessionId: management } = await cdp('Target.attachToTarget', {
    targetId: manager.targetId,
    flatten: true,
  });
  for (const loadPath of [auxiliary, root + '.output/chrome-mv3']) {
    await cdp(
      'Runtime.evaluate',
      {
        expression:
          'chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true});chrome.developerPrivate.loadUnpacked({failQuietly:true},()=>{});',
      },
      management,
    );
    await sleep(1000);
    for (const args of [
      ['key', 'ctrl+l'],
      ['type', '--clearmodifiers', loadPath + '/'],
      ['key', 'Return'],
      ['key', 'alt+o'],
    ]) {
      execFileSync('/usr/bin/xdotool', args, { env: { ...process.env, DISPLAY: displayName } });
      await sleep(600);
    }
  }
  const worker = await until(async () =>
    (await cdp('Target.getTargets')).targetInfos.find(
      (target) => target.type === 'service_worker' && target.url.endsWith('/background.js'),
    ),
  );
  const extensionId = new URL(worker.url).host;
  const panel = await cdp('Target.createTarget', {
    url: `chrome-extension://${extensionId}/sidepanel.html`,
  });
  const { sessionId: panelSession } = await cdp('Target.attachToTarget', {
    targetId: panel.targetId,
    flatten: true,
  });
  const { sessionId: workerSession } = await cdp('Target.attachToTarget', {
    targetId: worker.targetId,
    flatten: true,
  });
  const evaluate = async (expression, sessionId = panelSession) => {
    const result = await cdp(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const command = (message) => evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);
  const state = async () => (await command({ type: 'remote-state' })).value;
  const post = async (route, body) =>
    (
      await fetch(rpc + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json();
  await until(() => evaluate('!!document.querySelector("#detailed-enabled")'));
  await command({ type: 'remote-save', relayUrl, key: process.env.BROWSER_REMOTE_KEY });
  const endpoint = await until(() =>
    Object.keys(relay.ext.status()).find((key) => relay.ext.status()[key].connected),
  );
  await until(async () => (await state()).connected);
  assert.equal((await post('/diagnostics/detail', { endpoint })).ok, false);
  await command({ type: 'remote-detailed-set-enabled', enabled: true });
  const consent = (await state()).detailedDiagnostics.consent;
  await evaluate(
    `globalThis.previewCounts={frames:0,acks:0};const originalSend=chrome.debugger.sendCommand.bind(chrome.debugger);chrome.debugger.sendCommand=(target,method,...args)=>{if(method==='Page.screencastFrameAck')previewCounts.acks++;return originalSend(target,method,...args)};chrome.debugger.onEvent.addListener((_source,method)=>{if(method==='Page.screencastFrame')previewCounts.frames++});true`,
    workerSession,
  );
  await evaluate(
    `globalThis.testPreviewFrames=0;globalThis.testPreviewPort=chrome.runtime.connect({name:'live-page-preview'});testPreviewPort.onMessage.addListener(message=>{if(message.type==='preview-frame'){testPreviewFrames++;testPreviewPort.postMessage({type:'ack',sequence:message.frame.sequence})}});testPreviewPort.postMessage({type:'visibility',visible:true});true`,
  );
  evidence.actions = [];
  for (const mode of ['plain', 'foreigniframe']) {
    const tab = await evaluate(
      `chrome.tabs.create({url:${JSON.stringify(`http://127.0.0.1:${site.address().port}/?mode=${mode}`)},active:true})`,
    );
    await until(async () => (await evaluate(`chrome.tabs.get(${tab.id})`)).status === 'complete');
    const text = `Isolated ${mode} ${Date.now()}`;
    assert.equal(
      (
        await command({
          type: 'remote-chat-send',
          message: { role: 'user', content: [{ type: 'text', text }] },
          tabId: tab.id,
          windowId: tab.windowId,
        })
      ).ok,
      true,
    );
    const initial = await until(() =>
      requests.find((message) => message.text === text && message.request),
    );
    const decide = (request, decision) => post('/decision', { endpoint, id: request.id, decision });
    let result = await decide(initial.request, {
      kind: 'actions',
      actions: [
        {
          method: 'use-current-tab',
          params: { contextId: initial.request.context.pages[0].contextId },
        },
      ],
    });
    assert.ok(result.next, JSON.stringify(result));
    if (mode === 'plain') {
      await evaluate(
        `chrome.scripting.executeScript({target:{tabId:${tab.id}},func:()=>{let count=0;globalThis.fixtureAnimation=setInterval(()=>{document.body.style.backgroundColor=(++count%2)?'rgb(240,245,250)':'white'},60)}})`,
      );
      await until(
        async () =>
          (await evaluate('previewCounts', workerSession)).acks >= 30 &&
          (await evaluate('testPreviewFrames')) >= 10,
      );
      evidence.livePreview = {
        ...(await evaluate('previewCounts', workerSession)),
        panelFrames: await evaluate('testPreviewFrames'),
      };
      const pressure = (await command({ type: 'remote-detailed-preview', consent })).value;
      const cdpRecords = pressure.capture.records
        .filter((record) => record.text.startsWith('CDP '))
        .map((record) => JSON.parse(record.text.slice(4)));
      const ackRecords = cdpRecords.filter((record) => record.method === 'Page.screencastFrameAck');
      assert.ok(ackRecords.every((record) => ['error', 'slow-success'].includes(record.phase)));
      const ackSummaries = cdpRecords.filter((record) => record.event === 'screencast-ack-summary');
      assert.ok(ackSummaries.length > 0 && ackSummaries.length <= 3);
      assert.ok(ackSummaries.every((record) => record.partial && record.successful > 0));
      evidence.livePreview.ackRecords = ackRecords;
      evidence.livePreview.ackSummaries = ackSummaries;
      await evaluate(
        `chrome.scripting.executeScript({target:{tabId:${tab.id}},func:()=>clearInterval(globalThis.fixtureAnimation)})`,
      );
    }
    result = await decide(result.next, {
      kind: 'actions',
      actions: [{ method: 'find', params: { selector: '#field' } }],
    });
    assert.ok(result.next, JSON.stringify(result));
    const ref = result.next.execution.observation.page.matches[0].ref;
    result = await decide(result.next, {
      kind: 'actions',
      actions: [{ method: 'fill', params: { ref, text: 'PRIVATE_INPUT_CANARY' } }],
    });
    evidence.actions.push({ mode, result });
    if (mode === 'plain') {
      assert.ok(result.next && !result.next.execution.failed, JSON.stringify(result));
      const beforePreview = (await command({ type: 'remote-detail-share-prepare', consent })).value;
      await command({ type: 'remote-detail-share-grant', id: beforePreview.id });
      const beforeResume = await post('/diagnostics/detail', { endpoint });
      assert.equal(beforeResume.ok, true, JSON.stringify(beforeResume));
      const oldRecords = beforeResume.remoteEvidence.records;
      assert.ok(oldRecords.some((record) => record.kind === 'action' && record.method === 'fill'));
      relay.ext.conns.get(endpoint).ws.terminate();
      await sleep(1500);
      await until(async () => (await state()).connected);
      const afterPreview = (
        await command({
          type: 'remote-detail-share-prepare',
          consent: (await state()).detailedDiagnostics.consent,
        })
      ).value;
      await command({ type: 'remote-detail-share-grant', id: afterPreview.id });
      const afterResume = await post('/diagnostics/detail', { endpoint });
      assert.equal(afterResume.ok, true, JSON.stringify(afterResume));
      assert.equal(afterResume.remoteEvidence.connection.resumed, true);
      assert.ok(
        oldRecords.every((record) =>
          afterResume.remoteEvidence.records.some(
            (retained) => JSON.stringify(retained) === JSON.stringify(record),
          ),
        ),
      );
      evidence.taskResume = {
        oldRecordCount: oldRecords.length,
        retainedRecordCount: afterResume.remoteEvidence.records.length,
        connection: afterResume.remoteEvidence.connection,
        gaps: afterResume.remoteEvidence.gaps,
      };
      await decide(result.next, { kind: 'done', text: 'Local fixture completed' });
    } else {
      assert.ok(result.finished || result.next?.execution?.failed, JSON.stringify(result));
      if (result.next) await decide(result.next, { kind: 'done', text: 'Local fixture stopped' });
    }
    await until(async () => !(await state()).chatBusy);
  }
  await sleep(2100);
  await evaluate("console.warn('SHARE_EXACT_CANARY');true");
  await sleep(300);
  const prepared = (await command({ type: 'remote-detail-share-prepare', consent })).value;
  assert.ok(prepared.text.includes('SHARE_EXACT_CANARY'));
  const bundle = JSON.parse(prepared.text);
  assert.equal(bundle.schemaVersion, 2);
  assert.equal(bundle.kind, 'browser-incident-bundle');
  assert.equal(bundle.clock.remoteComparable, false);
  assert.ok(bundle.incidents.length > 0);
  assert.ok(
    bundle.correlations.some((item) => item.method === 'fill' && item.outcome === 'completed'),
  );
  for (const incident of bundle.incidents) {
    assert.equal(incident.window.complete, false);
    assert.ok(incident.window.gaps.includes('partial-diagnostic-capture'));
    assert.ok(incident.runtimeAtTrigger);
    assert.ok(incident.pageBefore && incident.pageState);
    assert.ok(incident.triggerFacts.length > 0 && incident.triggerFacts.length <= 3);
    if (incident.actionId)
      assert.ok(
        bundle.correlations.some(
          (item) => item.taskId === incident.taskId && item.actionId === incident.actionId,
        ),
      );
    else assert.ok(incident.window.gaps.includes('correlation-unavailable'));
  }
  evidence.extensionBuild = bundle.capture.build;
  const unauthorized = await evaluate(
    `chrome.runtime.sendMessage({type:'remote-detail-share-grant',id:${JSON.stringify(prepared.id)}}).catch(()=>null)`,
    workerSession,
  );
  assert.ok(unauthorized == null);
  assert.equal((await command({ type: 'remote-detail-share-grant', id: prepared.id })).ok, true);
  await evaluate("console.warn('AFTER_PREVIEW_CANARY');true");
  const result = await post('/diagnostics/detail', { endpoint });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, prepared.text);
  assert.equal(result.sha256, createHash('sha256').update(prepared.text).digest('hex'));
  assert.ok(!result.text.includes('AFTER_PREVIEW_CANARY'));
  const companion = result.remoteEvidence;
  assert.equal(companion.endpointId, endpoint);
  assert.equal(companion.clockAligned, false);
  assert.equal(companion.partial, true);
  assert.ok(companion.gaps.length > 0);
  assert.ok(
    companion.records.some((record) => record.kind === 'action' && record.method === 'fill'),
  );
  for (const record of companion.records)
    assert.ok(
      bundle.correlations.some(
        (item) =>
          item.taskId === record.taskId &&
          (record.kind !== 'action' || item.actionId === record.actionId),
      ),
    );
  assert.ok(!JSON.stringify(companion).includes('PRIVATE_INPUT_CANARY'));
  evidence.incidentBundle = bundle;
  evidence.remoteEvidence = companion;
  const { fetchDetail } = await import(
    new URL(
      '../scripts/detail-diagnostics.js',
      new URL(
        process.env.SHARE_REMOTE || '../../../zylos-browser-remote/src/index.js',
        import.meta.url,
      ),
    )
  );
  let cliFetchCount = 0;
  const degraded = await fetchDetail(
    { endpoint },
    {
      detailDiagnostics: async () => {
        cliFetchCount++;
        return { body: { ...result, remoteEvidence: { ...companion, clockAligned: true } } };
      },
    },
  );
  assert.equal(cliFetchCount, 1);
  assert.equal(degraded.ok, true);
  assert.equal(degraded.text, prepared.text);
  assert.equal(degraded.sha256, result.sha256);
  assert.equal(degraded.remoteEvidence, undefined);
  assert.ok(degraded.remoteEvidenceGap);
  evidence.companionFallback = {
    fetchCount: cliFetchCount,
    gap: degraded.remoteEvidenceGap,
    exactTextAndHashPreserved: true,
  };
  assert.equal((await post('/diagnostics/detail', { endpoint })).ok, false);
  evidence.checks.push(
    'default deny; trusted panel only; exact immutable hash; one-time retrieval',
  );
  const second = (await command({ type: 'remote-detail-share-prepare', consent })).value;
  await command({ type: 'remote-detail-share-grant', id: second.id });
  await command({ type: 'remote-detail-share-revoke' });
  assert.equal((await post('/diagnostics/detail', { endpoint })).ok, false);
  const third = (await command({ type: 'remote-detail-share-prepare', consent })).value;
  const offTab = await evaluate(
    `chrome.tabs.create({url:${JSON.stringify(`http://127.0.0.1:${site.address().port}/?mode=off`)},active:true})`,
  );
  await until(async () => (await evaluate(`chrome.tabs.get(${offTab.id})`)).status === 'complete');
  const offText = `Active diagnostics disable ${Date.now()}`;
  await command({
    type: 'remote-chat-send',
    message: { role: 'user', content: [{ type: 'text', text: offText }] },
    tabId: offTab.id,
    windowId: offTab.windowId,
  });
  const offRequest = await until(() =>
    requests.find((message) => message.text === offText && message.request),
  );
  const offResult = await post('/decision', {
    endpoint,
    id: offRequest.request.id,
    decision: {
      kind: 'actions',
      actions: [
        {
          method: 'use-current-tab',
          params: { contextId: offRequest.request.context.pages[0].contextId },
        },
      ],
    },
  });
  assert.ok(offResult.next);
  const probeCount = async () =>
    (
      await evaluate(
        `chrome.scripting.executeScript({target:{tabId:${offTab.id}},world:'ISOLATED',func:()=>Object.keys(globalThis).filter(key=>key.startsWith('__coco_frame_diagnostic_')).length})`,
      )
    )[0].result;
  await until(async () => (await probeCount()) > 0);
  await command({ type: 'remote-detailed-set-enabled', enabled: false });
  await until(async () => (await probeCount()) === 0);
  assert.equal((await state()).detailedDiagnostics.count, 0);
  assert.equal((await command({ type: 'remote-detailed-preview', consent })).ok, false);
  await post('/decision', {
    endpoint,
    id: offResult.next.id,
    decision: { kind: 'done', text: 'Local disable fixture complete' },
  });
  assert.equal((await command({ type: 'remote-detail-share-grant', id: third.id })).ok, false);
  evidence.checks.push(
    'explicit revoke; active capture-disable purges records and page probe; old preview and grant rejected',
  );
  await command({ type: 'remote-detailed-set-enabled', enabled: true });
  const currentConsent = (await state()).detailedDiagnostics.consent;
  const fourth = (await command({ type: 'remote-detail-share-prepare', consent: currentConsent }))
    .value;
  await command({ type: 'remote-detail-share-grant', id: fourth.id });
  relay.ext.conns.get(endpoint).ws.terminate();
  await sleep(1500);
  await until(async () => (await state()).connected);
  assert.equal((await post('/diagnostics/detail', { endpoint })).ok, false);
  evidence.checks.push('disconnect and reconnect revoke old grant');
  await evaluate(
    "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Preview a snapshot')||b.textContent.includes('预览用于')).click();true",
  );
  await until(() => evaluate("!!document.querySelector('input[type=checkbox]')"));
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Authorize one')||b.textContent.includes('授权读取')).disabled",
    ),
    true,
  );
  for (const width of [380, 1280]) {
    await cdp(
      'Emulation.setDeviceMetricsOverride',
      { width, height: 900, deviceScaleFactor: 1, mobile: false },
      panelSession,
    );
    await evaluate("document.querySelector('input[type=checkbox]').scrollIntoView();true");
    const screenshot = await cdp('Page.captureScreenshot', {}, panelSession);
    await fs.writeFile(`${evidenceDir}/share-${width}.png`, Buffer.from(screenshot.data, 'base64'));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  }
  await evaluate(
    "document.querySelector('input[type=checkbox]').click();[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Authorize one')||b.textContent.includes('授权读取')).click();true",
  );
  await until(() => evaluate("!!document.querySelector('[role=status]')"));
  assert.equal((await post('/diagnostics/detail', { endpoint })).ok, true);
  evidence.checks.push(
    'UI unchecked consent gates authorize; 380/1280 layouts; UI authorization retrieves',
  );
  await until(async () => (await state()).detailedSharing.phase === 'consumed');
  await until(() =>
    evaluate(
      "document.body.textContent.includes('Authorization consumed') || document.body.textContent.includes('授权已消耗')",
    ),
  );
  await command({ type: 'remote-diagnostics-set-enabled', enabled: true });
  await evaluate("console.warn('RAW_METADATA_EXCLUSION_CANARY');true");
  await sleep(200);
  assert.ok(!JSON.stringify(await state()).includes('RAW_METADATA_EXCLUSION_CANARY'));
  assert.ok(
    !JSON.stringify(await post('/diagnostics', { endpoint })).includes(
      'RAW_METADATA_EXCLUSION_CANARY',
    ),
  );
  const fifth = (await command({ type: 'remote-detail-share-prepare', consent: currentConsent }))
    .value;
  await command({ type: 'remote-detail-share-grant', id: fifth.id });
  await evaluate(
    'globalThis.shareRealNow=Date.now;Date.now=()=>shareRealNow()+121000;true',
    workerSession,
  );
  assert.equal((await post('/diagnostics/detail', { endpoint })).ok, false);
  await evaluate('Date.now=shareRealNow;true', workerSession);
  const sixth = (await command({ type: 'remote-detail-share-prepare', consent: currentConsent }))
    .value;
  await command({ type: 'remote-detail-share-grant', id: sixth.id });
  await command({
    type: 'remote-save',
    relayUrl: `ws://127.0.0.1:${relay.ext.server.address().port}/ext`,
    key: process.env.BROWSER_REMOTE_KEY,
  });
  await until(async () => (await state()).connected);
  assert.equal((await post('/diagnostics/detail', { endpoint })).ok, false);
  await command({ type: 'remote-detailed-set-enabled', enabled: true });
  assert.equal(
    (
      await command({
        type: 'remote-detail-share-prepare',
        consent: (await state()).detailedDiagnostics.consent,
      })
    ).ok,
    false,
  );
  evidence.checks.push(
    'consumed receipt; raw text excluded from state/metadata; TTL expiry; config revocation; insecure ws denied',
  );
  evidence.success = true;
} catch (error) {
  evidence.error = error.stack;
  process.exitCode = 1;
  console.error(error.stack);
} finally {
  socket?.close();
  for (const process of [browser, display])
    if (process && process.exitCode === null) {
      process.kill('SIGTERM');
      await Promise.race([once(process, 'exit'), sleep(3000)]);
      if (process.exitCode === null && process.signalCode === null) {
        process.kill('SIGKILL');
        await once(process, 'exit');
      }
    }
  relay?.close();
  if (tls) await new Promise((resolve) => tls.close(resolve));
  if (site) await new Promise((resolve) => site.close(resolve));
  await fs.writeFile(evidenceDir + '/results.json', JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify({
      success: evidence.success,
      error: evidence.error,
      sourceCommit: evidence.sourceCommit,
      remoteSourceCommit: evidence.remoteSourceCommit,
      checks: evidence.checks,
      livePreview: evidence.livePreview,
      taskResume: evidence.taskResume,
      companionFallback: evidence.companionFallback,
      evidenceDir,
    }),
  );
}
