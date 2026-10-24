// @vitest-environment node
// Deterministic lifecycle races against a fake Chrome API, no personal browser access.
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { observationCdp } from '../fixtures/observation-cdp.mjs';
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
      handlers,
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
    runtime: { id: 'a'.repeat(32), onMessage: event() },
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
    tabGroups: { update: async () => ({ id: 10 }), onRemoved: event() },
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
test('control loss revision excludes ordinary cleanup but records external debugger cancellation', async () => {
  const s = await observationSetup();
  s.executor.initializeExecutor();
  const initial = s.executor.controlLossRevision();
  await s.executor.completeTask();
  assert.equal(s.executor.controlLossRevision(), initial);
  const fresh = await observationSetup();
  fresh.executor.initializeExecutor();
  const before = fresh.executor.controlLossRevision();
  chrome.debugger.onDetach.emit({ tabId: fresh.tab.id }, 'canceled_by_user');
  assert.equal(fresh.executor.controlLossRevision(), before + 1);
  assert.equal(fresh.executor.currentControl(), null);
  await new Promise((resolve) => setTimeout(resolve, 0));
});
test('cosmetic group update failure does not fail a valid owned-tab observation', async () => {
  const s = await observationSetup();
  chrome.tabGroups.update = async () => {
    throw new Error('Temporary group styling failure');
  };
  const result = await s.executor.execute({ op: 'snapshot' }, Date.now() + 10000);
  assert.match(result.text, /Save failed/);
  assert.equal(s.executor.currentControl().tabId, s.tab.id);
  await s.executor.release(false);
});

async function borrowedWithPopup() {
  const s = await observationSetup();
  s.executor.initializeExecutor();
  const source = await chrome.tabs.get(1);
  await s.executor.useExistingTab({ tabId: 1, windowId: 1, url: source.url }, () => {});
  const popup = { ...source, id: 4, groupId: -1, openerTabId: 1 };
  chrome.tabs.get = async (id) => {
    if (id === 1) return source;
    if (id === 4) return popup;
    throw new Error('No tab');
  };
  chrome.tabs.group = async () => {
    popup.groupId = 10;
    return 10;
  };
  chrome.tabs.onCreated.emit(popup);
  await s.executor.flushTaskPopups();
  assert.equal(s.executor.currentControl().groupId, 10);
  return { ...s, source, popup };
}

test('missing popup group cannot strand the borrowed original tab', async () => {
  const s = await borrowedWithPopup();
  chrome.tabs.onRemoved.emit(4);
  chrome.tabGroups.update = async () => {
    throw new Error('No group with id: 10.');
  };
  const result = await s.executor.execute({ op: 'snapshot' }, Date.now() + 10000);
  assert.match(result.text, /Save failed/);
  assert.equal(s.executor.currentControl().borrowedTabId, 1);
  assert.equal(s.executor.currentControl().groupId, null);
  await s.executor.release(false);
});

test.each(['missing', 'temporary', 'exists'])(
  'group lookup distinguishes %s after cosmetic failure',
  async (state) => {
    const s = await borrowedWithPopup();
    chrome.tabGroups.update = async () => {
      throw new Error('Styling failed');
    };
    chrome.tabGroups.get = async () => {
      if (state === 'missing') throw new Error('No group with id: 10.');
      if (state === 'temporary') throw new Error('Service unavailable');
      return { id: 10 };
    };
    await s.executor.execute({ op: 'snapshot' }, Date.now() + 10000);
    assert.equal(s.executor.currentControl().groupId, state === 'missing' ? null : 10);
    await s.executor.release(false);
  },
);

test('group removal clears borrowed popup membership without regrouping it', async () => {
  const s = await borrowedWithPopup();
  let grouped = 0;
  chrome.tabs.group = async () => {
    grouped++;
    return 11;
  };
  chrome.tabGroups.onRemoved.emit({ id: 10, windowId: 1 });
  assert.deepEqual(s.executor.currentControl().tabIds, [1]);
  assert.equal(s.executor.currentControl().groupId, null);
  assert.equal(grouped, 0);
  await s.executor.release(false);
});

test('removing an owned target group still revokes control', async () => {
  const s = await observationSetup();
  s.executor.initializeExecutor();
  chrome.tabGroups.onRemoved.emit({ id: 10, windowId: 1 });
  assert.equal(s.executor.currentControl(), null);
  await new Promise((resolve) => setTimeout(resolve, 0));
});
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

test('consent revocation during task creation has a precise diagnostic reason', async () => {
  const s = await setup();
  const diagnostics = await import('../../utils/diagnostics');
  const recorded = vi.spyOn(diagnostics, 'recordDiagnostic');
  const entered = deferred(),
    proceed = deferred();
  const get = chrome.tabs.get;
  chrome.tabs.get = async (id) => {
    entered.resolve();
    await proceed.promise;
    return get(id);
  };
  const starting = s.start();
  const rejected = assert.rejects(starting, (error) => error.code === 'STOPPED');
  await entered.promise;
  await s.executor.release();
  proceed.resolve();
  await rejected;
  assert.ok(
    recorded.mock.calls.some(
      ([event, reason]) => event === 'stopped' && reason === 'consent_changed',
    ),
  );
});

async function observationSetup() {
  const s = await setup();
  const methods = [];
  chrome.debugger.sendCommand = async (_target, method, params) => {
    methods.push(method);
    const observation = observationCdp(method, params);
    if (observation) return observation;
    if (method === 'Accessibility.getFullAXTree')
      return {
        nodes: [{ role: { value: 'button' }, name: { value: 'Save failed' }, backendDOMNodeId: 1 }],
      };
    if (method === 'Page.getFrameTree')
      return { frameTree: { frame: { id: 'main', loaderId: 'document-1' } } };
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

async function recoverySetup() {
  const s = await observationSetup();
  const suspended = vi.fn(),
    revoked = vi.fn();
  s.executor.configureControlRecovery({
    enabled: () => true,
    onSuspended: suspended,
    onRevoked: revoked,
  });
  s.executor.initializeExecutor();
  const detach = (reason = 'target_closed') => {
    s.attached.delete(s.tab.id);
    chrome.debugger.onDetach.emit({ tabId: s.tab.id }, reason);
  };
  return { ...s, suspended, revoked, detach };
}

async function frameSelectionSetup() {
  const s = await recoverySetup();
  chrome.webNavigation = { getFrame: async () => ({ documentId: 'document-1', url: s.tab.url }) };
  s.executor.configureControlRecovery({
    enabled: () => true,
    frameSelectionEnabled: () => true,
    onSuspended: s.suspended,
    onRevoked: s.revoked,
  });
  await s.executor.execute({ op: 'frames' }, Date.now() + 10000);
  s.detach();
  const candidate = {
    id: crypto.randomUUID(),
    extensionOrigin: `chrome-extension://${'b'.repeat(32)}`,
  };
  const inspection = {
    candidates: [candidate],
    truncated: false,
    coverage: 'root-document-open-shadow',
  };
  const scripts = [];
  const sender = {
    id: chrome.runtime.id,
    tab: { id: s.tab.id, windowId: 1 },
    frameId: 0,
    documentId: 'document-1',
    url: s.tab.url,
  };
  const authorize = (args, overrides = {}) =>
    new Promise((resolve) =>
      chrome.runtime.onMessage.handlers[0](
        { type: 'recovery-frame-authorize', recoveryId: args.recoveryId, nonce: args.nonce },
        { ...sender, ...overrides },
        resolve,
      ),
    );
  chrome.scripting = {
    executeScript: async (request) => {
      const args = request.args[0];
      scripts.push(args.action);
      assert.deepEqual(request.target, { tabId: s.tab.id, documentIds: ['document-1'] });
      assert.equal(request.world, 'ISOLATED');
      if (args.action === 'revoke') return [];
      const result =
        args.action === 'inspect'
          ? { inspection }
          : (await authorize(args)).allowed
            ? { removed: 1 }
            : { error: 'RECOVERY_UNAVAILABLE' };
      return [{ frameId: 0, documentId: 'document-1', result }];
    },
  };
  return { ...s, candidate, inspection, scripts, authorize };
}

test('inspection is immutable, does not attach and selected removal requires authenticated one-use authorization', async () => {
  const s = await frameSelectionSetup();
  const descriptor = s.executor.currentControlRecovery();
  assert.equal(descriptor.frameSelection, true);
  const initial = await s.executor.inspectRecoveryFrames(descriptor.recoveryId);
  assert.deepEqual(initial.inspection, s.inspection);
  assert.deepEqual(await s.executor.inspectRecoveryFrames(descriptor.recoveryId), initial);
  assert.deepEqual(s.scripts, ['inspect']);
  assert.equal(s.executor.currentGrant(), null);
  assert.equal(s.attached.size, 0);
  const script = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (request) => {
    const args = request.args[0];
    if (args.action === 'remove') {
      for (const forged of [
        { id: 'wrong' },
        { documentId: 'other' },
        { frameId: 1 },
        { tab: { id: 99 } },
      ])
        assert.deepEqual(await s.authorize(args, forged), { allowed: false });
      assert.deepEqual(await s.authorize({ ...args, nonce: 'wrong' }), { allowed: false });
      assert.deepEqual(await s.authorize(args), { allowed: true });
      assert.deepEqual(await s.authorize(args), { allowed: false });
      return [{ frameId: 0, documentId: 'document-1', result: { removed: 1 } }];
    }
    return script(request);
  };
  const result = await s.executor.recoverControl(descriptor.recoveryId, Infinity, [s.candidate.id]);
  assert.equal(result.recovered, true);
  assert.equal(result.replayed, false);
  await s.executor.release(false);
});

test('child-document inspection removes a candidate only through its own document', async () => {
  const s = await frameSelectionSetup();
  const child = { documentId: 'document-2', frameId: 5, url: 'https://child.example/form' };
  chrome.webNavigation.getAllFrames = async () => [
    { frameId: 0, documentId: 'document-1', url: s.tab.url },
    { frameId: 5, documentId: 'document-2', parentDocumentId: 'document-1', url: child.url },
    // Extension pages cannot be scripted; unrelated documents are never reached.
    {
      frameId: 6,
      documentId: 'ext-doc',
      parentDocumentId: 'document-2',
      url: `chrome-extension://${'b'.repeat(32)}/menu.html`,
    },
    {
      frameId: 7,
      documentId: 'broken-doc',
      parentDocumentId: 'document-1',
      url: 'https://broken.example/',
    },
    {
      frameId: 8,
      documentId: 'other-doc',
      parentDocumentId: 'elsewhere',
      url: 'https://other.example/',
    },
  ];
  s.executor.configureControlRecovery({
    enabled: () => true,
    frameSelectionEnabled: () => true,
    closedShadowEnabled: () => true,
    childFramesEnabled: () => true,
    onSuspended: s.suspended,
    onRevoked: s.revoked,
  });
  const candidate = {
    id: crypto.randomUUID(),
    extensionOrigin: `chrome-extension://${'b'.repeat(32)}`,
  };
  const targets = [];
  let authorizations;
  chrome.scripting.executeScript = async (request) => {
    const args = request.args[0];
    const [documentId] = request.target.documentIds;
    targets.push(`${args.action}:${documentId}`);
    if (args.action === 'revoke') return [];
    if (documentId === 'broken-doc') throw new Error('Cannot access frame');
    const frameId = documentId === 'document-2' ? 5 : 0;
    assert.equal(args.url, documentId === 'document-2' ? child.url : s.tab.url);
    if (args.action === 'inspect')
      return [
        {
          frameId,
          documentId,
          result: {
            inspection: {
              candidates: documentId === 'document-2' ? [candidate] : [],
              truncated: false,
              coverage: 'root-document-open-and-closed-shadow',
            },
          },
        },
      ];
    const root = { frameId: 0, documentId: 'document-1', url: s.tab.url };
    authorizations = [
      await s.authorize(args, root),
      await s.authorize(args, { ...child, documentId: 'document-2', frameId: 0 }),
      await s.authorize(args, child),
      await s.authorize(args, child),
    ];
    return [{ frameId, documentId, result: { removed: 1 } }];
  };
  const id = s.executor.currentControlRecovery().recoveryId;
  const { inspection } = await s.executor.inspectRecoveryFrames(id);
  assert.deepEqual(inspection, {
    candidates: [candidate],
    truncated: true,
    coverage: 'documents-open-and-closed-shadow',
  });
  assert.deepEqual(targets.sort(), [
    'inspect:broken-doc',
    'inspect:document-1',
    'inspect:document-2',
  ]);
  const result = await s.executor.recoverControl(id, Infinity, [candidate.id]);
  assert.equal(result.recovered, true);
  assert.ok(targets.includes('remove:document-2'));
  assert.ok(!targets.includes('remove:document-1'));
  assert.deepEqual(
    authorizations.map((item) => item.allowed),
    [false, false, true, false],
  );
  await s.executor.release(false);
});

test.each(['unknown', 'duplicate', 'document'])(
  'selected recovery fails terminal before removal for %s',
  async (invalid) => {
    const s = await frameSelectionSetup();
    const id = s.executor.currentControlRecovery().recoveryId;
    await s.executor.inspectRecoveryFrames(id);
    if (invalid === 'document')
      chrome.webNavigation.getFrame = async () => ({ documentId: 'new-document', url: s.tab.url });
    const selected =
      invalid === 'unknown'
        ? [crypto.randomUUID()]
        : invalid === 'duplicate'
          ? [s.candidate.id, s.candidate.id]
          : [s.candidate.id];
    await assert.rejects(s.executor.recoverControl(id, Infinity, selected));
    assert.ok(!s.scripts.includes('remove'));
    assert.equal(s.attached.size, 0);
    assert.equal(s.executor.currentControl(), null);
    await s.executor.release(false);
  },
);

test('Stop while removal authorization awaits tab validation prevents authorization and attachment', async () => {
  const s = await frameSelectionSetup();
  const id = s.executor.currentControlRecovery().recoveryId;
  await s.executor.inspectRecoveryFrames(id);
  const entered = deferred(),
    resume = deferred();
  const script = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (request) => {
    if (request.args[0].action === 'remove') {
      const get = chrome.tabs.get;
      chrome.tabs.get = async (...args) => {
        entered.resolve();
        await resume.promise;
        return get(...args);
      };
    }
    return script(request);
  };
  const attempt = s.executor.recoverControl(id, Infinity, [s.candidate.id]);
  const rejected = assert.rejects(attempt);
  await entered.promise;
  const stop = s.executor.release(false);
  resume.resolve();
  await rejected;
  await stop;
  assert.equal(s.attached.size, 0);
  assert.equal(s.executor.currentGrant(), null);
});
test('recovery blocks automatic unpark, uses exact original tab once and returns fresh refs without input', async () => {
  const s = await recoverySetup();
  s.detach();
  const recovery = s.executor.currentControlRecovery();
  assert.equal(recovery.cause, 'unknown');
  assert.equal(s.executor.currentGrant(), null);
  await assert.rejects(
    s.executor.execute({ op: 'snapshot' }, Infinity),
    (e) => e.code === 'CONTROL_SUSPENDED',
  );
  chrome.tabs.onUpdated.emit(s.tab.id, { status: 'complete' }, s.tab);
  await Promise.resolve();
  assert.equal(s.attached.size, 0);
  const result = await s.executor.execute(
    { op: 'recover-control', recoveryId: recovery.recoveryId },
    Infinity,
  );
  assert.equal(result.recovered, true);
  assert.match(result.observation.text, /Save failed/);
  assert.equal(result.replayed, false);
  assert.equal(s.executor.currentGrant().id, s.tab.id);
  assert.equal(
    s.methods.some((method) => method.startsWith('Input.')),
    false,
  );
  await assert.rejects(
    s.executor.execute({ op: 'recover-control', recoveryId: recovery.recoveryId }, Infinity),
    (e) => e.code === 'RECOVERY_UNAVAILABLE',
  );
  s.detach();
  const second = s.executor.currentControlRecovery();
  assert.notEqual(second.recoveryId, recovery.recoveryId);
  await s.executor.recoverControl(second.recoveryId);
  s.detach();
  assert.equal(s.executor.currentControlRecovery(), undefined);
  assert.equal(s.executor.currentControl(), null);
});
async function automaticSetup() {
  const s = await recoverySetup();
  s.executor.configureControlRecovery({
    enabled: () => true,
    automaticEnabled: () => true,
    onSuspended: s.suspended,
    onRevoked: s.revoked,
  });
  return s;
}

async function automaticRemovalSetup() {
  const s = await frameSelectionSetup();
  let allowed = true;
  s.executor.configureControlRecovery({
    enabled: () => true,
    frameSelectionEnabled: () => true,
    automaticEnabled: () => true,
    automaticRemovalEnabled: () => allowed,
    onSuspended: s.suspended,
    onRevoked: s.revoked,
  });
  const script = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (request) =>
    request.args[0].action === 'probe'
      ? [{ frameId: 0, documentId: 'document-1', result: { inspection: s.inspection } }]
      : script(request);
  return {
    ...s,
    revoke: () => {
      allowed = false;
    },
  };
}

test('current-task compatibility grant removes only inspected candidates and recovers without input', async () => {
  const s = await automaticRemovalSetup();
  const result = await s.executor.autoRecoverControl();
  assert.equal(result.recovered, true);
  assert.deepEqual(result.removal, { requested: 1, removed: 1, outcome: 'completed' });
  assert.deepEqual(s.scripts, ['inspect', 'remove']);
  assert.equal(
    s.methods.some((method) => method.startsWith('Input.')),
    false,
  );
  await s.executor.release(false);
});

test('compatibility mode refuses a truncated inspection', async () => {
  const s = await automaticRemovalSetup();
  const script = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (request) => {
    const result = await script(request);
    if (request.args[0].action === 'inspect')
      result[0].result.inspection = { ...s.inspection, truncated: true };
    return result;
  };
  assert.equal(await s.executor.autoRecoverControl(), undefined);
  assert.deepEqual(s.scripts, ['inspect']);
  assert.equal(s.attached.size, 0);
  await s.executor.release(false);
});

test('compatibility grant revoked while asynchronous removal waits prevents removal authorization', async () => {
  const s = await automaticRemovalSetup();
  const script = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (request) => {
    if (request.args[0].action === 'remove') s.revoke();
    return script(request);
  };
  assert.equal(await s.executor.autoRecoverControl(), undefined);
  assert.equal(s.attached.size, 0);
  assert.equal(await s.executor.autoRecoverControl(), undefined);
  await s.executor.release(false);
});

test('failed attach after automatic removal preserves an explicit uncertain removal receipt', async () => {
  const s = await automaticRemovalSetup();
  chrome.debugger.attach = async () => {
    throw new Error('attach failed');
  };
  assert.equal(await s.executor.autoRecoverControl(), undefined);
  assert.deepEqual(s.executor.currentControlRecovery().removalReceipt, {
    requested: 1,
    outcome: 'unknown',
  });
  assert.deepEqual(s.scripts, ['inspect', 'remove']);
  assert.equal(await s.executor.autoRecoverControl(), undefined);
  await s.executor.release(false);
});

test('compatibility revoke during asynchronous authorization validation denies the document', async () => {
  const s = await automaticRemovalSetup();
  const script = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (request) => {
    if (request.args[0].action === 'remove') {
      const get = chrome.tabs.get;
      chrome.tabs.get = async (id) => {
        const tab = await get(id);
        s.revoke();
        return tab;
      };
      assert.deepEqual(await s.authorize(request.args[0]), { allowed: false });
      return [{ frameId: 0, documentId: 'document-1', result: { error: 'RECOVERY_UNAVAILABLE' } }];
    }
    return script(request);
  };
  assert.equal(await s.executor.autoRecoverControl(), undefined);
  assert.equal(s.attached.size, 0);
  await s.executor.release(false);
});

test.each([
  'recover',
  'recover-delayed',
  'owner-update',
  'late-owner-update',
  'revoke',
  'navigation',
  'type-unknown-caret',
])(
  'prepared input handles %s before insertion without replaying focus or text',
  async (scenario) => {
    const s = await automaticRemovalSetup();
    await s.executor.recoverControl(s.executor.currentControlRecovery().recoveryId);
    const snapshot = await s.executor.execute({ op: 'snapshot' }, Infinity);
    const ref = snapshot.text.match(/@[a-f0-9]{8}-e\d+/)[0];
    const { PageActions } = await import('../../utils/automation/page-actions');
    let prepared = 0,
      inserted = 0,
      ownerUpdated = false;
    const prepare = vi
      .spyOn(PageActions.prototype, 'prepareInput')
      .mockImplementation(async function () {
        prepared++;
        this.io.onInputPrepared?.({ value: '', selectionStart: 0, selectionEnd: 0 });
        if (scenario === 'recover-delayed') {
          setTimeout(() => s.detach(), 20);
          throw new Error('Detached while handling command.');
        }
        s.detach();
        if (scenario === 'owner-update') ownerUpdated = true;
        if (scenario === 'revoke') s.revoke();
        if (scenario === 'navigation')
          chrome.webNavigation.getFrame = async () => ({
            documentId: 'new-document',
            url: s.tab.url,
          });
      });
    const commit = vi
      .spyOn(PageActions.prototype, 'commitInput')
      .mockImplementation(async function () {
        if (scenario === 'late-owner-update') ownerUpdated = true;
        await this.io.send('Input.insertText', { text: 'fixture' });
        inserted++;
        return { done: true };
      });
    try {
      const work = s.executor.execute(
        { op: scenario === 'type-unknown-caret' ? 'type' : 'fill', ref, text: 'fixture' },
        Infinity,
        {
          beforeInput: () => {
            if (ownerUpdated)
              throw Object.assign(new Error('Owner update'), { code: 'OWNER_INPUT_REQUIRED' });
          },
        },
      );
      if (scenario === 'recover' || scenario === 'recover-delayed') {
        assert.deepEqual(await work, { done: true });
        assert.equal(inserted, 1);
      } else {
        await assert.rejects(work);
        assert.equal(inserted, 0);
      }
      assert.equal(prepared, 1);
    } finally {
      prepare.mockRestore();
      commit.mockRestore();
      await s.executor.release(false);
    }
  },
);

test('automatic reattachment runs once per detach outside the Agent budget and restores its own refs', async () => {
  const s = await automaticSetup();
  const before = await s.executor.execute({ op: 'snapshot' }, Infinity);
  const ref = before.text.match(/@[a-f0-9]{8}-e\d+/)[0];
  s.detach();
  const recovery = s.executor.currentControlRecovery();
  const result = await s.executor.autoRecoverControl();
  assert.equal(result.recovered, true);
  assert.equal(result.replayed, false);
  assert.equal(s.executor.currentControlRecovery(), undefined);
  assert.equal(s.executor.currentGrant().id, s.tab.id);
  assert.equal(s.executor.restoreRecoveredRefs([ref, '@00000000-e9']), 1);
  assert.equal(
    s.methods.some((method) => method.startsWith('Input.')),
    false,
  );
  // The Agent's own three attempts remain available after automatic recoveries.
  for (let i = 0; i < 2; i++) {
    s.detach();
    await s.executor.recoverControl(s.executor.currentControlRecovery().recoveryId);
  }
  assert.notEqual(s.executor.currentControlRecovery()?.recoveryId, recovery.recoveryId);
  await s.executor.release(false);
});

test('a failed automatic attempt leaves the same lease for the Agent and is not retried', async () => {
  const s = await automaticSetup();
  s.detach();
  const recovery = s.executor.currentControlRecovery();
  const attach = chrome.debugger.attach;
  chrome.debugger.attach = async () => {
    throw new Error('Cannot access a chrome-extension:// URL of different extension');
  };
  assert.equal(await s.executor.autoRecoverControl(), undefined);
  assert.equal(s.executor.currentControlRecovery().recoveryId, recovery.recoveryId);
  assert.equal(await s.executor.autoRecoverControl(), undefined);
  chrome.debugger.attach = attach;
  const result = await s.executor.recoverControl(recovery.recoveryId);
  assert.equal(result.recovered, true);
  // Manual recovery never rebinds old refs.
  assert.equal(s.executor.restoreRecoveredRefs(['@00000000-e1']), 0);
  await s.executor.release(false);
});

test('automatic reattachment waits while a foreign extension frame remains and then gives way', async () => {
  const s = await frameSelectionSetup();
  s.executor.configureControlRecovery({
    enabled: () => true,
    frameSelectionEnabled: () => true,
    automaticEnabled: () => true,
    onSuspended: s.suspended,
    onRevoked: s.revoked,
  });
  const probes = [];
  chrome.scripting.executeScript = async (request) => {
    probes.push(request.args[0].action);
    return [
      {
        frameId: 0,
        documentId: 'document-1',
        result: {
          inspection: {
            candidates: [{ id: 'x', extensionOrigin: 'chrome-extension://' + 'b'.repeat(32) }],
            truncated: false,
            coverage: 'root-document-open-shadow',
          },
        },
      },
    ];
  };
  const started = Date.now();
  assert.equal(await s.executor.autoRecoverControl(), undefined);
  assert.ok(Date.now() - started >= 4500);
  assert.ok(probes.length >= 5 && probes.every((action) => action === 'probe'));
  assert.equal(s.attached.size, 0);
  assert.ok(s.executor.currentControlRecovery());
  await s.executor.release(false);
}, 15000);

test('automatic recovery stops probing when negotiated capabilities disappear', async () => {
  const s = await frameSelectionSetup();
  let ready = true;
  s.executor.configureControlRecovery({
    enabled: () => ready,
    frameSelectionEnabled: () => ready,
    closedShadowEnabled: () => ready,
    childFramesEnabled: () => ready,
    automaticEnabled: () => ready,
    onSuspended: s.suspended,
    onRevoked: s.revoked,
  });
  chrome.webNavigation.getAllFrames = async () => [];
  let probes = 0;
  chrome.scripting.executeScript = async () => {
    probes++;
    ready = false;
    return [{ result: { inspection: { candidates: [], truncated: false } } }];
  };
  const recover = s.executor.currentControlRecovery();
  vi.useFakeTimers();
  try {
    const pending = s.executor.autoRecoverControl();
    await vi.advanceTimersByTimeAsync(5200);
    assert.equal(await pending, undefined);
  } finally {
    vi.useRealTimers();
  }
  assert.equal(probes, 1);
  assert.equal(s.attached.size, 0);
  assert.equal(s.executor.currentControlRecovery().recoveryId, recover.recoveryId);
  assert.equal(s.executor.currentControlRecovery().attempted, undefined);
  await s.executor.release(false);
});

test('automatic recovery records repeated frame presence and the eventual clear probe', async () => {
  const s = await frameSelectionSetup();
  const diagnostics = await import('../../utils/diagnostics');
  const recorded = vi.spyOn(diagnostics, 'recordDiagnostic');
  s.executor.configureControlRecovery({
    enabled: () => true,
    automaticEnabled: () => true,
    frameSelectionEnabled: () => true,
    onSuspended: s.suspended,
    onRevoked: s.revoked,
  });
  let probes = 0;
  chrome.scripting.executeScript = async () => [
    {
      result: {
        inspection: {
          candidates: ++probes < 3 ? [{ id: 'foreign' }] : [],
          truncated: false,
        },
      },
    },
  ];
  vi.useFakeTimers();
  try {
    const pending = s.executor.autoRecoverControl();
    await vi.advanceTimersByTimeAsync(1000);
    assert.equal((await pending).recovered, true);
    const results = recorded.mock.calls.filter(
      ([event, , data]) =>
        event === 'operation-result' && data?.method === 'inspect-recovery-frames',
    );
    assert.deepEqual(
      results.map(([, , data]) => [data.status, data.count, data.code]),
      [
        ['error', 1, 'FOREIGN_FRAME_PRESENT'],
        ['error', 1, 'FOREIGN_FRAME_PRESENT'],
        ['success', undefined, undefined],
      ],
    );
  } finally {
    vi.useRealTimers();
    recorded.mockRestore();
    await s.executor.release(false);
  }
});

test.each(['reconnect', 'missing-scope', 'stop'])(
  'automatic recovery handles %s during its bounded wait',
  async (mode) => {
    const s = await frameSelectionSetup();
    let ready = true;
    let childrenReady = true;
    s.executor.configureControlRecovery({
      enabled: () => ready,
      automaticEnabled: () => ready,
      frameSelectionEnabled: () => ready,
      closedShadowEnabled: () => ready,
      childFramesEnabled: () => ready && childrenReady,
      onSuspended: s.suspended,
      onRevoked: s.revoked,
    });
    chrome.webNavigation.getAllFrames = async () => [];
    let probes = 0;
    chrome.scripting.executeScript = async (request) => {
      if (request.args[0].action !== 'probe') return [];
      assert.equal(request.args[0].allowClosedShadow, true);
      probes++;
      if (probes === 1) ready = false;
      return [{ result: { inspection: { candidates: [], truncated: false } } }];
    };
    vi.useFakeTimers();
    try {
      const pending = s.executor.autoRecoverControl();
      await vi.advanceTimersByTimeAsync(350);
      assert.equal(s.attached.size, 0);
      assert.equal(probes, 1);
      if (mode === 'stop') await s.executor.release(false);
      childrenReady = mode !== 'missing-scope';
      ready = true;
      await vi.advanceTimersByTimeAsync(5100);
      const result = await pending;
      if (mode === 'reconnect') {
        assert.equal(result.recovered, true);
        assert.equal(probes, 2);
      } else {
        assert.equal(result, undefined);
        assert.equal(s.attached.size, 0);
        assert.equal(probes, 1);
      }
    } finally {
      vi.useRealTimers();
      await s.executor.release(false);
    }
  },
);

test.each(['child-error', 'truncated'])(
  'automatic recovery does not attach after an incomplete %s probe',
  async (failure) => {
    const s = await frameSelectionSetup();
    s.executor.configureControlRecovery({
      enabled: () => true,
      frameSelectionEnabled: () => true,
      closedShadowEnabled: () => true,
      childFramesEnabled: () => true,
      automaticEnabled: () => true,
      onSuspended: s.suspended,
      onRevoked: s.revoked,
    });
    chrome.webNavigation.getAllFrames = async () => [
      {
        frameId: 1,
        documentId: 'child',
        parentDocumentId: 'document-1',
        url: 'https://child.example/',
      },
    ];
    chrome.scripting.executeScript = async (request) => {
      if (failure === 'child-error' && request.target.documentIds[0] === 'child')
        throw new Error('Cannot inspect child');
      return [{ result: { inspection: { candidates: [], truncated: failure === 'truncated' } } }];
    };
    vi.useFakeTimers();
    try {
      const pending = s.executor.autoRecoverControl();
      await vi.advanceTimersByTimeAsync(5100);
      assert.equal(await pending, undefined);
      assert.equal(s.attached.size, 0);
      assert.ok(s.executor.currentControlRecovery());
    } finally {
      vi.useRealTimers();
      await s.executor.release(false);
    }
  },
);

test('explicit Chrome cancellation never enters recovery', async () => {
  const s = await recoverySetup();
  s.detach('canceled_by_user');
  assert.equal(s.suspended.mock.calls.length, 0);
  assert.equal(s.executor.currentControlRecovery(), undefined);
  assert.equal(s.executor.currentControl(), null);
});

test('rolling recovery budget reopens at exactly 30 seconds but task stops after three attempts', async () => {
  const s = await recoverySetup();
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    for (let i = 0; i < 2; i++) {
      s.detach();
      await s.executor.recoverControl(s.executor.currentControlRecovery().recoveryId);
    }
    now += 30000;
    s.detach();
    await s.executor.recoverControl(s.executor.currentControlRecovery().recoveryId);
    now += 30000;
    s.detach();
    assert.equal(s.executor.currentControlRecovery(), undefined);
    assert.equal(s.executor.currentControl(), null);
  } finally {
    clock.mockRestore();
    await s.executor.release(false);
  }
});

test('recovery initializes nested OOPIF sessions while the normal grant is suspended', async () => {
  const s = await recoverySetup();
  s.detach();
  const send = chrome.debugger.sendCommand;
  const calls = [];
  chrome.debugger.sendCommand = async (target, method, params) => {
    calls.push([target.sessionId, method]);
    if (method === 'Target.setAutoAttach') {
      assert.equal(s.executor.currentGrant(), null);
      const child = !target.sessionId ? 'child' : target.sessionId === 'child' ? 'nested' : null;
      if (child)
        chrome.debugger.onEvent.emit(target, 'Target.attachedToTarget', {
          sessionId: child,
          targetInfo: { type: 'iframe', targetId: child },
        });
      // Events from another tab and an unknown parent session are not in scope.
      chrome.debugger.onEvent.emit({ tabId: 99 }, 'Target.attachedToTarget', {
        sessionId: 'foreign',
        targetInfo: { type: 'iframe', targetId: 'foreign' },
      });
      chrome.debugger.onEvent.emit(
        { tabId: s.tab.id, sessionId: 'unknown' },
        'Target.attachedToTarget',
        {
          sessionId: 'orphan',
          targetInfo: { type: 'iframe', targetId: 'orphan' },
        },
      );
    }
    return send(target, method, params);
  };
  await s.executor.recoverControl(s.executor.currentControlRecovery().recoveryId);
  for (const id of ['child', 'nested']) {
    assert.ok(
      calls.some(([session, method]) => session === id && method === 'Target.setAutoAttach'),
    );
    assert.ok(calls.some(([session, method]) => session === id && method === 'Page.getFrameTree'));
  }
  assert.ok(!calls.some(([session]) => ['foreign', 'orphan'].includes(session)));
  await s.executor.release(false);
});

test.each([
  ['Page.enable', 'Stop'],
  ['Network.enable', 'Stop'],
  ['Page.enable', 'deadline'],
  ['Network.enable', 'deadline'],
  ['Page.enable', 'task-replacement'],
  ['Network.enable', 'task-replacement'],
])(
  '%s delayed child initialization is fenced by %s during recovery',
  async (blockedMethod, revoke) => {
    const s = await recoverySetup();
    s.detach();
    const send = chrome.debugger.sendCommand;
    const entered = deferred(),
      resume = deferred();
    const calls = [];
    let roots = 0;
    chrome.debugger.sendCommand = async (target, method, params) => {
      calls.push([target.sessionId, method]);
      if (!target.sessionId && method === 'Target.setAutoAttach') {
        const child = ++roots === 1 ? 'child' : 'next-child';
        chrome.debugger.onEvent.emit(target, 'Target.attachedToTarget', {
          sessionId: child,
          targetInfo: { type: 'iframe', targetId: child },
        });
      }
      if (target.sessionId === 'child' && method === blockedMethod) {
        entered.resolve();
        await resume.promise;
      }
      return send(target, method, params);
    };
    const attempt = s.executor.recoverControl(s.executor.currentControlRecovery().recoveryId);
    const rejected = assert.rejects(attempt);
    await entered.promise;
    const previous = s.executor.currentControl().sessionId;
    const expiredAt = Date.now() + 10001;
    const clock =
      revoke === 'deadline' ? vi.spyOn(Date, 'now').mockReturnValue(expiredAt) : undefined;
    const stopping =
      revoke === 'task-replacement'
        ? s.executor.release(false).then(() => s.start())
        : revoke === 'Stop'
          ? s.executor.release(false)
          : Promise.resolve();
    const frames = await import('../../utils/automation/frames');
    if (revoke !== 'deadline') assert.equal(frames.frameSessions().size, 0);
    resume.resolve();
    await rejected;
    await stopping;
    clock?.mockRestore();
    assert.ok(
      !calls.some(([session, method]) => session === 'child' && method === 'Target.setAutoAttach'),
    );
    if (revoke === 'task-replacement') {
      assert.notEqual(s.executor.currentControl().sessionId, previous);
      assert.equal(s.executor.currentGrant().id, s.tab.id);
      await s.executor.release(false);
    } else assert.equal(s.executor.currentGrant(), null);
  },
);
test('a same-URL document replacement during recovery observation fails closed', async () => {
  const s = await recoverySetup();
  s.detach();
  const send = chrome.debugger.sendCommand;
  let reads = 0;
  chrome.debugger.sendCommand = async (target, method, params) => {
    const value = await send(target, method, params);
    if (method === 'Page.getFrameTree' && ++reads >= 3)
      value.frameTree.frame.loaderId = 'document-2';
    return value;
  };
  await assert.rejects(
    s.executor.recoverControl(s.executor.currentControlRecovery().recoveryId),
    (e) => e.code === 'PAGE_CHANGED',
  );
  assert.equal(s.executor.currentGrant(), null);
  assert.equal(s.attached.size, 0);
  assert.deepEqual(s.revoked.mock.calls.at(-1), ['failed']);
});
test.each(['url', 'windowId', 'groupId'])(
  'recovery refuses changed %s even without a prior event',
  async (key) => {
    const s = await recoverySetup();
    s.detach();
    const recovery = s.executor.currentControlRecovery();
    s.tab[key] = key === 'url' ? 'https://other.test/' : 99;
    await assert.rejects(s.executor.recoverControl(recovery.recoveryId));
    assert.equal(s.attached.size, 0);
    assert.equal(s.executor.currentControl(), null);
  },
);
test('Stop revokes immediately during attach and late success is detached before releasing the queue', async () => {
  const s = await recoverySetup();
  s.detach();
  const entered = deferred(),
    complete = deferred();
  chrome.debugger.attach = async ({ tabId }) => {
    entered.resolve();
    await complete.promise;
    s.attached.add(tabId);
  };
  const attempt = s.executor.recoverControl(s.executor.currentControlRecovery().recoveryId);
  const rejected = assert.rejects(attempt);
  await entered.promise;
  const stop = s.executor.execute({ op: 'stop' }, Infinity);
  assert.equal(s.executor.currentControl(), null);
  assert.equal(s.executor.currentControlRecovery(), undefined);
  complete.resolve();
  await Promise.all([rejected, stop]);
  assert.equal(s.attached.size, 0);
  assert.equal(s.executor.currentGrant(), null);
});
test('idle suspension expires at the original absolute deadline', async () => {
  const s = await recoverySetup();
  vi.useFakeTimers();
  try {
    s.detach();
    const deadline = s.executor.currentControlRecovery().expiresAt;
    await vi.advanceTimersByTimeAsync(119999);
    assert.equal(s.executor.currentControlRecovery().expiresAt, deadline);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(s.executor.currentControlRecovery(), undefined);
    assert.equal(s.executor.currentControl(), null);
    assert.equal(s.revoked.mock.calls.length, 1);
    assert.deepEqual(s.revoked.mock.calls[0], ['expired']);
  } finally {
    vi.useRealTimers();
  }
});
test('attach has a ten second budget; a later native completion cannot restore control', async () => {
  const s = await recoverySetup();
  s.detach();
  const entered = deferred(),
    complete = deferred();
  chrome.debugger.attach = async ({ tabId }) => {
    entered.resolve();
    await complete.promise;
    s.attached.add(tabId);
  };
  vi.useFakeTimers();
  try {
    const attempt = s.executor.recoverControl(s.executor.currentControlRecovery().recoveryId);
    const rejected = assert.rejects(attempt, (e) => e.code === 'RECOVERY_EXPIRED');
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    assert.equal(s.executor.currentControl(), null);
    complete.resolve();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(s.attached.size, 0);
  } finally {
    vi.useRealTimers();
  }
});
test('an unconfirmed late detach fences the tab against future task attachment', async () => {
  const s = await recoverySetup();
  s.detach();
  const entered = deferred(),
    complete = deferred();
  let attaches = 0;
  chrome.debugger.attach = async ({ tabId }) => {
    attaches++;
    entered.resolve();
    await complete.promise;
    s.attached.add(tabId);
  };
  chrome.debugger.detach = async () => {
    throw new Error('Native detach failed');
  };
  const attempt = s.executor.recoverControl(s.executor.currentControlRecovery().recoveryId);
  const rejected = assert.rejects(attempt);
  await entered.promise;
  const stopping = s.executor.release();
  complete.resolve();
  await Promise.all([rejected, stopping]);
  await assert.rejects(s.start(), (e) => e.code === 'DEBUGGER_DETACH_FAILED');
  assert.equal(attaches, 1);
  assert.equal(s.executor.currentGrant(), null);
});

test('wait distinguishes its polling deadline from the outer command deadline', async () => {
  for (const [budget, code] of [
    [10000, 'WAIT_TIMEOUT'],
    [500, 'COMMAND_EXPIRED'],
  ]) {
    const s = await observationSetup();
    vi.useFakeTimers();
    try {
      const original = chrome.debugger.sendCommand;
      chrome.debugger.sendCommand = async (target, method, params) => {
        const result = await original(target, method, params);
        // A read begun before the wait expires completes just after its deadline.
        if (method === 'Page.getFrameTree') vi.setSystemTime(Date.now() + 1200);
        return result;
      };
      await assert.rejects(
        s.executor.execute(
          { op: 'wait', condition: 'visible', selector: '#missing', timeoutMs: 800 },
          Date.now() + budget,
        ),
        (e) => e.code === code,
      );
    } finally {
      vi.useRealTimers();
      await s.executor.release();
    }
  }
});

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
test.each(['complete', 'stop'])(
  'a slow screenshot waits without a deadline until %s',
  async (outcome) => {
    const s = await observationSetup();
    vi.useFakeTimers();
    try {
      const entered = deferred(),
        pixels = deferred();
      const original = chrome.debugger.sendCommand;
      chrome.debugger.sendCommand = async (target, method, params) => {
        if (method === 'Page.captureScreenshot') {
          entered.resolve();
          return pixels.promise;
        }
        return original(target, method, params);
      };
      let settled = false;
      const shot = s.executor.execute({ op: 'screenshot' }, Infinity);
      void shot.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await entered.promise;
      await vi.advanceTimersByTimeAsync(60_000);
      assert.equal(settled, false);
      if (outcome === 'stop') {
        const rejected = assert.rejects(shot, (e) => e.code === 'STOPPED');
        await s.executor.release();
        await vi.advanceTimersByTimeAsync(50);
        await rejected;
      }
      pixels.resolve({ data: 'PNG-FIXTURE' });
      await vi.advanceTimersByTimeAsync(0);
      if (outcome === 'complete') assert.equal((await shot).data, 'PNG-FIXTURE');
      await s.executor.release();
    } finally {
      vi.useRealTimers();
    }
  },
);
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
    const observation = observationCdp(method, params);
    if (observation) return observation;
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
