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
    id: 1,
    windowId: 1,
    groupId: 10,
    active: true,
    incognito: false,
    url: 'https://example.com/',
    title: 'Fixture',
  };
  globalThis.chrome = {
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: {
      get: async () => tab,
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
  return { executor, attached, entered, proceed, tab };
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
  chrome.tabs.onUpdated.emit(1, { status: 'complete' }, s.tab);
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
  assert.equal(s.executor.currentGrant().id, 1);
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
  const starting = s.executor.attach(1);
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
  await s.executor.attach(1);
  return { ...s, methods };
}

test('CDP leases bind to consent and tab, reject sensitive domains, and expire on finish', async () => {
  const s = await observationSetup();
  const leaseId = crypto.randomUUID();
  const controlSessionId = s.executor.currentControl().sessionId;
  const deadline = Date.now() + 10000;
  await assert.rejects(
    s.executor.bindCdp({ leaseId, controlSessionId: crypto.randomUUID(), deadline }),
    (e) => e.code === 'CONTROL_NOT_GRANTED',
  );
  const bound = await s.executor.bindCdp({ leaseId, controlSessionId, deadline });
  const request = { type: 'cdp-command', id: crypto.randomUUID(), ...bound, deadline, params: {} };
  await assert.rejects(
    s.executor.executeCdp({ ...request, method: 'Network.getAllCookies' }),
    (e) => e.code === 'CDP_METHOD_NOT_ALLOWED',
  );
  await assert.rejects(
    s.executor.executeCdp({
      ...request,
      method: 'Page.navigate',
      params: { url: 'file:///private' },
    }),
    (e) => e.code === 'UNSUPPORTED_PAGE',
  );
  await assert.rejects(
    s.executor.executeCdp({ ...request, method: 'Input.insertText', sessionId: 'foreign-frame' }),
    (e) => e.code === 'CDP_METHOD_NOT_ALLOWED',
  );
  await s.executor.executeCdp({ ...request, method: 'Page.getFrameTree' });
  s.tab.windowId = 2;
  await assert.rejects(
    s.executor.executeCdp({ ...request, method: 'Page.getFrameTree' }),
    (e) => e.code === 'PAGE_CHANGED',
  );
  s.tab.windowId = 1;
  await s.executor.execute({ op: 'finish' }, deadline);
  await assert.rejects(
    s.executor.executeCdp({ ...request, method: 'Page.getFrameTree' }),
    (e) => e.code === 'CDP_SESSION_EXPIRED',
  );
  assert.equal(s.executor.currentControl().sessionId, controlSessionId);
});
test('MCP cursor arrival precedes input; stop or navigation during animation prevents the native write', async () => {
  for (const interruption of ['none', 'stop', 'navigate']) {
    const s = await observationSetup();
    s.executor.initializeExecutor();
    const bound = await s.executor.bindCdp({
      leaseId: crypto.randomUUID(),
      controlSessionId: s.executor.currentControl().sessionId,
      deadline: Date.now() + 10000,
    });
    const entered = deferred(),
      proceed = deferred();
    const original = chrome.debugger.sendCommand;
    const writes = [];
    chrome.debugger.sendCommand = async (target, method, params = {}) => {
      if (method === 'Runtime.evaluate' && params.expression.includes('document.activeElement'))
        return { result: { value: { sensitive: false, point: { x: 110, y: 90 } } } };
      if (
        method === 'Runtime.evaluate' &&
        params.expression.includes('renderCursor({"action":"input"')
      ) {
        assert.ok(params.expression.includes('"waitForArrival":true'));
        entered.resolve();
        await proceed.promise;
      }
      if (method.startsWith('Input.')) writes.push(method);
      return original(target, method, params);
    };
    const writing = s.executor.executeCdp({
      type: 'cdp-command',
      id: crypto.randomUUID(),
      ...bound,
      deadline: Date.now() + 10000,
      method: 'Input.insertText',
      params: { text: 'fixture' },
    });
    const rejection =
      interruption !== 'none'
        ? assert.rejects(
            writing,
            (e) => e.code === (interruption === 'stop' ? 'CDP_SESSION_EXPIRED' : 'PAGE_CHANGED'),
          )
        : null;
    await entered.promise;
    assert.deepEqual(writes, []);
    if (interruption === 'stop') await s.executor.release();
    if (interruption === 'navigate')
      chrome.debugger.onEvent.emit({ tabId: 1 }, 'Page.frameNavigated', {
        frame: { url: 'https://example.com/next' },
      });
    proceed.resolve();
    if (rejection) await rejection;
    else await writing;
    assert.deepEqual(writes, interruption !== 'none' ? [] : ['Input.insertText']);
    await s.executor.release();
  }
});
test('MCP password checks reject both focused text and object-bound focus before cursor feedback', async () => {
  const s = await observationSetup();
  const bound = await s.executor.bindCdp({
    leaseId: crypto.randomUUID(),
    controlSessionId: s.executor.currentControl().sessionId,
    deadline: Date.now() + 10000,
  });
  const original = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (target, method, params = {}) => {
    if (method.startsWith('Runtime.')) return { result: { value: { sensitive: true } } };
    return original(target, method, params);
  };
  for (const request of [
    { method: 'Input.insertText', params: { text: 'secret' } },
    {
      method: 'Runtime.callFunctionOn',
      params: { objectId: 'password', functionDeclaration: 'function() { this.focus(); }' },
    },
  ])
    await assert.rejects(
      s.executor.executeCdp({
        type: 'cdp-command',
        id: crypto.randomUUID(),
        ...bound,
        deadline: Date.now() + 10000,
        ...request,
      }),
      (e) => e.code === 'SENSITIVE_INPUT',
    );
  assert.equal(
    s.methods.some((m) => m.startsWith('Input.') || m === 'Page.createIsolatedWorld'),
    false,
  );
  await s.executor.release();
});
test('MCP native mouse trajectories stop on navigation, lost authorization, or a changed hit target', async () => {
  for (const interruption of ['stop', 'navigate', 'ungroup', 'hit-change']) {
    const s = await observationSetup();
    s.executor.initializeExecutor();
    const bound = await s.executor.bindCdp({
      leaseId: crypto.randomUUID(),
      controlSessionId: s.executor.currentControl().sessionId,
      deadline: Date.now() + 10000,
    });
    const original = chrome.debugger.sendCommand;
    const moves = [];
    let presses = 0;
    chrome.debugger.sendCommand = async (target, method, params = {}) => {
      if (method === 'DOM.getNodeForLocation')
        return {
          backendNodeId: interruption === 'hit-change' && moves.length ? 2 : 1,
          frameId: 'main',
        };
      if (method === 'Input.dispatchMouseEvent') {
        assert.equal(target.tabId, bound.tabId);
        if (params.type === 'mousePressed') presses++;
        if (params.type === 'mouseMoved') {
          moves.push(params);
          if (moves.length === 3) {
            if (interruption === 'stop') await s.executor.release();
            if (interruption === 'navigate')
              chrome.debugger.onEvent.emit({ tabId: 1 }, 'Page.frameNavigated', {
                frame: { url: 'https://example.com/next' },
              });
            // No event is emitted: every sample must also re-read the actual tab scope.
            if (interruption === 'ungroup') s.tab.groupId = -1;
          }
        }
      }
      return original(target, method, params);
    };
    await assert.rejects(
      s.executor.executeCdp({
        type: 'cdp-command',
        id: crypto.randomUUID(),
        ...bound,
        deadline: Date.now() + 10000,
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: 100, y: 100, button: 'left', clickCount: 1 },
      }),
      (e) =>
        e.code ===
        {
          stop: 'CDP_SESSION_EXPIRED',
          navigate: 'PAGE_CHANGED',
          ungroup: 'PAGE_CHANGED',
          'hit-change': 'ELEMENT_CHANGED_DURING_MOVE',
        }[interruption],
    );
    assert.equal(presses, 0);
    assert.ok(moves.length >= 3);
    if (interruption !== 'hit-change') assert.equal(moves.length, 3);
    await s.executor.release();
  }
});
test('MCP refuses text if focus enters a password field during cursor arrival', async () => {
  const s = await observationSetup();
  const bound = await s.executor.bindCdp({
    leaseId: crypto.randomUUID(),
    controlSessionId: s.executor.currentControl().sessionId,
    deadline: Date.now() + 10000,
  });
  const original = chrome.debugger.sendCommand;
  let focusedReads = 0;
  chrome.debugger.sendCommand = async (target, method, params = {}) => {
    if (method === 'Runtime.evaluate' && params.expression.includes('document.activeElement'))
      return {
        result: {
          value: ++focusedReads === 1 ? { sensitive: false, point: { x: 100, y: 100 } } : true,
        },
      };
    return original(target, method, params);
  };
  await assert.rejects(
    s.executor.executeCdp({
      type: 'cdp-command',
      id: crypto.randomUUID(),
      ...bound,
      deadline: Date.now() + 10000,
      method: 'Input.insertText',
      params: { text: 'not delivered' },
    }),
    (e) => e.code === 'SENSITIVE_INPUT',
  );
  assert.equal(focusedReads, 2);
  assert.equal(s.methods.includes('Input.insertText'), false);
  await s.executor.release();
});
test('observe returns fresh refs, screenshot and the authorized page identity without input events', async () => {
  const s = await observationSetup();
  const result = await s.executor.execute(
    { op: 'observe', interactive: false },
    Date.now() + 10000,
  );
  assert.match(result.text, /Save failed/);
  assert.equal(result.screenshot.data, 'PNG-FIXTURE');
  assert.equal(result.tabId, 1);
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

test('stop during native cursor movement prevents the pending legacy click', async () => {
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
  await s.executor.attach(1);
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
