// @vitest-environment node
// Deterministic lifecycle races against a fake Chrome API, no personal browser access.
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function setup() {
  const event = () => {
    const handlers = [];
    return {
      addListener(fn) {
        handlers.push(fn);
      },
      emit(...args) {
        handlers.forEach((fn) => fn(...args));
      },
    };
  };
  const entered = deferred(),
    proceed = deferred();
  const attached = new Set();
  const tab = {
    id: 3,
    windowId: 1,
    groupId: 10,
    active: true,
    incognito: false,
    url: 'https://example.com/',
    title: 'Fixture',
  };
  const source = { ...tab, id: 1, index: 0, groupId: -1, url: 'https://example.com/personal' };
  globalThis.chrome = {
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: {
      get: async (id) => (id === source.id ? source : tab),
      create: async (props) => Object.assign(tab, props),
      onCreated: event(),
      query: async () => [tab],
      group: async () => 10,
      onActivated: event(),
      onUpdated: event(),
      onDetached: event(),
      onRemoved: event(),
    },
    windows: { onRemoved: event() },
    tabGroups: { update: async () => ({ id: 10 }) },
    debugger: {
      getTargets: async () => [...attached].map((tabId) => ({ tabId, attached: true })),
      onDetach: event(),
      onEvent: event(),
      attach: async ({ tabId }) => {
        entered.resolve();
        await proceed.promise;
        attached.add(tabId);
      },
      detach: async ({ tabId }) => {
        attached.delete(tabId);
      },
      sendCommand: async () => ({}),
    },
  };
  const storageData = { local: {}, session: {} };
  chrome.storage = Object.fromEntries(
    ['local', 'session'].map((area) => [
      area,
      {
        get: async (key) => ({ [key]: storageData[area][key] }),
        set: async (values) => Object.assign(storageData[area], structuredClone(values)),
      },
    ]),
  );
  chrome.tabs.remove ??= async (id) => {
    attached.delete(id);
  };
  chrome.tabs.ungroup ??= async () => {};
  vi.resetModules();
  const executor = await import('../../utils/automation/executor');
  const start = () =>
    executor.createTask({ sourceTabId: 1, windowId: 1, url: tab.url, taskId: crypto.randomUUID() });
  return { executor, attached, entered, proceed, tab, start };
}
test('finish detaches, stays parked on tab events, resumes on a tool, and stop still revokes', async () => {
  const s = await observationSetup();
  s.executor.initializeExecutor();
  const session = s.executor.currentControl().sessionId;
  assert.equal(s.attached.size, 1);
  const before = await s.executor.execute({ op: 'snapshot' }, Date.now() + 10000);
  const oldRef = before.text
    .split('\n')
    .find((l) => l.includes('Save failed'))
    .split(' ')[0];
  assert.equal(
    (await s.executor.execute({ op: 'finish' }, Date.now() + 10000)).debuggerDetached,
    true,
  );
  assert.equal(s.attached.size, 0);
  assert.equal(s.executor.currentGrant(), null);
  assert.equal(s.executor.currentControl().sessionId, session);
  chrome.tabs.onActivated.emit({ windowId: 1, tabId: 1 });
  chrome.tabs.onUpdated.emit(s.tab.id, { status: 'complete' }, s.tab);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(s.attached.size, 0, 'Passive events must not bring back the debugging banner');
  await s.executor.execute({ op: 'tabs' }, Date.now() + 10000);
  assert.equal(s.attached.size, 0, 'Listing tabs needs no debugger');
  await assert.rejects(
    s.executor.execute({ op: 'click', ref: oldRef }, Date.now() + 10000),
    (e) => e.code === 'STALE_ELEMENT',
  );
  assert.equal(s.attached.size, 1);
  assert.equal(s.executor.currentControl().sessionId, session);
  await s.executor.execute({ op: 'finish' }, Date.now() + 10000);
  await s.executor.release();
  await assert.rejects(
    s.executor.execute({ op: 'snapshot' }, Date.now() + 10000),
    (e) => e.code === 'CONTROL_NOT_GRANTED',
  );
});
test('finish failure does not claim success, and finishing never creates consent', async () => {
  const s = await observationSetup();
  const detach = chrome.debugger.detach;
  chrome.debugger.detach = async () => {
    throw new Error('fixture detach failure');
  };
  await assert.rejects(
    s.executor.execute({ op: 'finish' }, Date.now() + 10000),
    (e) => e.code === 'DEBUGGER_DETACH_FAILED',
  );
  assert.equal(s.attached.size, 1);
  chrome.debugger.detach = detach;
  await s.executor.execute({ op: 'finish' }, Date.now() + 10000);
  assert.equal(s.attached.size, 0);
  await s.executor.release();
  await s.executor.execute({ op: 'finish' }, Date.now() + 10000);
  assert.equal(s.executor.currentControl(), null);
});
test('switching user focus does not attach another tab or invalidate task refs', async () => {
  const s = await observationSetup();
  s.executor.initializeExecutor();
  const attach = vi.fn(chrome.debugger.attach);
  chrome.debugger.attach = attach;
  const before = s.executor.currentControl();
  s.tab.active = false;
  chrome.tabs.onActivated.emit({ windowId: 1, tabId: 2 });
  await s.executor.execute({ op: 'snapshot' }, Date.now() + 10000);
  assert.equal(s.executor.currentGrant().id, s.tab.id);
  assert.deepEqual(s.executor.currentControl(), before);
  assert.equal(attach.mock.calls.length, 0);
  await s.executor.execute({ op: 'finish' }, Date.now() + 10000);
  assert.equal(s.attached.size, 0);
  await s.executor.release();
});

test('stop during finish never restores retained consent', async () => {
  const s = await observationSetup();
  const entered = deferred(),
    proceed = deferred();
  const detach = chrome.debugger.detach;
  chrome.debugger.detach = async (target) => {
    entered.resolve();
    await proceed.promise;
    await detach(target);
  };
  const finishing = s.executor.execute({ op: 'finish' }, Date.now() + 10000);
  const rejected = assert.rejects(finishing, (e) => e.code === 'STOPPED');
  await entered.promise;
  const stopping = s.executor.release();
  proceed.resolve();
  await Promise.all([rejected, stopping]);
  assert.equal(s.executor.currentControl(), null);
  assert.equal(s.attached.size, 0);
});
test('stop during debugger attachment cannot resurrect window consent', async () => {
  const s = await setup();
  const starting = s.start();
  const rejected = assert.rejects(starting, (error) => error.code === 'STOPPED');
  await s.entered.promise;
  const stopping = s.executor.release();
  assert.equal(s.executor.currentControl(), null);
  assert.equal(s.executor.currentGrant(), null);
  s.proceed.resolve();
  await Promise.all([rejected, stopping]);
  assert.equal(s.attached.size, 0);
  assert.equal(s.executor.currentControl(), null);
  await assert.rejects(
    s.executor.execute({ op: 'open', url: 'https://example.com/' }, Date.now() + 1000),
    (error) => error.code === 'CONTROL_NOT_GRANTED',
  );
});

async function observationSetup() {
  const s = await setup();
  const methods = [];
  chrome.debugger.sendCommand = async (_target, method) => {
    methods.push(method);
    if (method === 'Accessibility.getFullAXTree')
      return {
        nodes: [{ role: { value: 'button' }, name: { value: 'Save failed' }, backendDOMNodeId: 1 }],
      };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: 1, frameId: 'main' };
    if (method === 'Runtime.evaluate')
      return {
        result: {
          value: {
            readyState: 'complete',
            width: 800,
            height: 600,
            scrollX: 0,
            scrollY: 0,
            dpr: 1,
          },
        },
      };
    if (method === 'Page.captureScreenshot') return { data: 'PNG-FIXTURE' };
    return {};
  };
  s.proceed.resolve();
  await s.start();
  return { ...s, methods };
}

test('observe returns fresh refs, screenshot and the authorized page identity without input events', async () => {
  const s = await observationSetup();
  const result = await s.executor.execute(
    { op: 'observe', interactive: false },
    Date.now() + 10000,
  );
  assert.match(result.text, /Save failed/);
  assert.equal(result.screenshot.data, 'PNG-FIXTURE');
  assert.equal(result.tabId, s.tab.id);
  assert.equal(result.url, s.tab.url);
  assert.equal(result.viewport.width, 800);
  assert.equal(result.pageVersion.split(':')[0], s.executor.currentControl().sessionId);
  assert.equal(
    s.methods.some((m) => m.startsWith('Input.')),
    false,
  );
  await s.executor.release();
});
test('loading pages do not produce a falsely ready observation', async () => {
  const s = await observationSetup();
  s.tab.status = 'loading';
  await assert.rejects(
    s.executor.execute({ op: 'observe' }, Date.now() + 10000),
    (e) => e.code === 'PAGE_LOADING',
  );
  assert.equal(s.methods.includes('Page.captureScreenshot'), false);
  await s.executor.release();
});
test('stop or switching away during screenshot prevents pixels from being returned', async () => {
  for (const cancel of [true, false]) {
    const s = await observationSetup();
    const entered = deferred(),
      proceed = deferred();
    const original = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = async (target, method, params) => {
      if (method === 'Page.captureScreenshot') {
        entered.resolve();
        await proceed.promise;
      }
      return original(target, method, params);
    };
    const pending = s.executor.execute({ op: 'observe' }, Date.now() + 10000);
    const rejected = assert.rejects(pending, (e) => ['STOPPED', 'PAGE_CHANGED'].includes(e.code));
    await entered.promise;
    if (cancel) await s.executor.release();
    else s.tab.groupId = -1;
    proceed.resolve();
    await rejected;
    await s.executor.release();
  }
});
test('oversized screenshot is rejected locally without disconnecting or leaving usable refs', async () => {
  const s = await observationSetup();
  const original = chrome.debugger.sendCommand;
  let generatedRef;
  const prior = await s.executor.execute({ op: 'snapshot', interactive: true }, Date.now() + 10000);
  generatedRef = prior.text
    .split('\n')
    .find((line) => line.includes('Save failed'))
    .split(' ')[0];
  chrome.debugger.sendCommand = async (target, method, params) =>
    method === 'Page.captureScreenshot'
      ? { data: 'A'.repeat(7_000_001) }
      : original(target, method, params);
  await assert.rejects(
    s.executor.execute({ op: 'observe' }, Date.now() + 10000),
    (e) => e.code === 'SCREENSHOT_TOO_LARGE',
  );
  assert.ok(s.executor.currentControl());
  await assert.rejects(
    s.executor.execute({ op: 'click', ref: generatedRef }, Date.now() + 10000),
    (e) => e.code === 'STALE_ELEMENT',
  );
  await s.executor.release();
});

test('stop during native cursor movement prevents the pending click', async () => {
  const s = await setup();
  const entered = deferred(),
    proceed = deferred();
  const writes = [];
  chrome.debugger.sendCommand = async (_target, method, params) => {
    if (method === 'Accessibility.getFullAXTree')
      return {
        nodes: [{ role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 1 }],
      };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'button' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: { x: 100, y: 100 } } };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: 1, frameId: 'main' };
    if (method === 'Runtime.evaluate' && params.expression.includes('width:innerWidth'))
      return { result: { value: { width: 800, height: 600 } } };
    if (method === 'Runtime.evaluate' && params.expression.includes('"nativePoint":true')) {
      entered.resolve();
      await proceed.promise;
    }
    if (method === 'Runtime.evaluate' && params.expression.includes('"action":"remove"'))
      proceed.resolve();
    if (method.startsWith('Input.')) writes.push(params.type);
    return {};
  };
  s.proceed.resolve();
  await s.start();
  const snapshot = await s.executor.execute(
    { op: 'snapshot', interactive: true },
    Date.now() + 10000,
  );
  const ref = snapshot.text
    .split('\n')
    .find((line) => line.includes('"Save"'))
    .split(' ')[0];
  const pending = s.executor.execute({ op: 'click', ref }, Date.now() + 10000);
  const rejected = assert.rejects(pending, (error) =>
    ['STOPPED', 'CONTROL_NOT_GRANTED'].includes(error.code),
  );
  await entered.promise;
  await s.executor.release();
  await rejected;
  assert.deepEqual(writes, ['mouseMoved']);
  assert.equal(s.executor.currentControl(), null);
});
