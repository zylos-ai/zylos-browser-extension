// @vitest-environment node
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';

async function fixture() {
  const event = () => {
    const handlers = [];
    return {
      addListener: (f) => handlers.push(f),
      emit: (...args) => handlers.forEach((f) => f(...args)),
    };
  };
  const tabs = new Map(
    [1, 2].map((id) => [
      id,
      {
        id,
        index: id - 1,
        windowId: 1,
        groupId: -1,
        incognito: false,
        active: id === 1,
        url: `https://example.com/user-${id}`,
        title: `User ${id}`,
      },
    ]),
  );
  const groups = new Map();
  const attached = new Set();
  const calls = [];
  const pruneGroups = () => {
    for (const id of groups.keys())
      if (![...tabs.values()].some((t) => t.groupId === id)) groups.delete(id);
  };
  let nextTab = 3,
    nextGroup = 10;
  const getTab = (id) => {
    if (!tabs.has(id)) throw new Error('No tab');
    return tabs.get(id);
  };
  globalThis.chrome = {
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: {
      get: async (id) => ({ ...getTab(id) }),
      query: async (q) =>
        [...tabs.values()].filter(
          (t) =>
            (q.windowId === undefined || t.windowId === q.windowId) &&
            (q.active === undefined || t.active === q.active),
        ),
      create: async (props) => {
        const t = { id: nextTab++, groupId: -1, incognito: false, title: 'Work', ...props };
        tabs.set(t.id, t);
        calls.push({ method: 'tabs.create', ...props });
        return { ...t };
      },
      group: async (props) => {
        if (props.groupId === undefined)
          assert.equal(
            props.createProperties?.windowId,
            getTab(props.tabIds[0]).windowId,
            'New groups must explicitly use the task window, not Chrome focus',
          );
        const id = props.groupId ?? nextGroup++;
        if (!groups.has(id)) groups.set(id, { id });
        for (const tabId of props.tabIds) getTab(tabId).groupId = id;
        return id;
      },
      update: async (id, props) => {
        Object.assign(getTab(id), props);
        calls.push({ method: 'tabs.update', id, ...props });
        return { ...getTab(id) };
      },
      onUpdated: event(),
      onActivated: event(),
      onDetached: event(),
      onRemoved: event(),
    },
    tabGroups: {
      update: async (id, props) => {
        if (!groups.has(id)) throw new Error('No group');
        Object.assign(groups.get(id), props);
        calls.push({ method: 'tabGroups.update', id, ...props });
        return groups.get(id);
      },
    },
    windows: { onRemoved: event(), update: async () => {} },
    debugger: {
      attach: async ({ tabId }) => attached.add(tabId),
      detach: async ({ tabId }) => attached.delete(tabId),
      getTargets: async () => [...attached].map((tabId) => ({ tabId, attached: true })),
      onDetach: event(),
      onEvent: event(),
      sendCommand: async (target, method, params) => {
        calls.push({ tabId: target.tabId, method, params });
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
        if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
        if (method === 'Runtime.evaluate')
          return { result: { value: { width: 800, height: 600, reducedMotion: true } } };
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 1, frameId: 'main' };
        return {};
      },
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
    tabs.delete(id);
    attached.delete(id);
    pruneGroups();
  };
  chrome.tabs.ungroup ??= async (id) => {
    getTab(id).groupId = -1;
    pruneGroups();
  };
  vi.resetModules();
  const executor = await import('../../utils/automation/executor');
  executor.initializeExecutor();
  const command = (command) => executor.execute(command, Date.now() + 10000);
  return { executor, tabs, groups, attached, calls, command };
}

test('finalize closes only task-created temporary tabs, keeps explicit results, and rejects old tasks', async () => {
  const s = await fixture();
  await s.executor.attach(1, 'new');
  assert.deepEqual(
    s.calls.find((c) => c.method === 'tabs.create'),
    {
      method: 'tabs.create',
      windowId: 1,
      index: 1,
      openerTabId: 1,
      url: 'about:blank',
      active: false,
    },
  );
  const task = s.executor.currentControl();
  const result = await s.command({ op: 'new-tab', url: 'https://example.com/result' });
  s.tabs.get(2).groupId = task.groupId; // A user tab in the group is still not ours.
  await s.command({ op: 'pause' });
  assert.ok(s.tabs.has(task.tabId));
  assert.equal(s.attached.size, 0);
  const receipt = await s.command({ op: 'finalize', taskId: task.sessionId, keep: [result.tabId] });
  assert.equal(s.executor.currentControl(), null);
  assert.equal(s.tabs.has(task.tabId), false);
  assert.ok(s.tabs.has(1) && s.tabs.has(2) && s.tabs.has(result.tabId));
  assert.equal(s.tabs.get(result.tabId).groupId, -1);
  assert.deepEqual(await s.command({ op: 'finalize', taskId: task.sessionId, keep: [] }), receipt);
  await s.executor.attach(1, 'new');
  await assert.rejects(
    s.command({ op: 'finalize', taskId: task.sessionId, keep: [] }),
    (e) => e.code === 'STALE_TASK',
  );
  assert.ok(s.tabs.has(s.executor.currentControl().tabId));
  await s.executor.release();
});

test('handoff keeps the group; completion removes it without a terminal-status rename', async () => {
  for (const outcome of ['temporary', 'deliverable', 'stop']) {
    const s = await fixture();
    await s.executor.attach(1, 'new');
    const task = s.executor.currentControl();
    await s.command({ op: 'pause' });
    assert.equal(s.groups.get(task.groupId).title, 'Coco Agent · 等待继续');
    assert.equal(s.tabs.get(task.tabId).groupId, task.groupId);
    assert.equal(s.attached.size, 0);
    // The legacy reply barrier must not turn a handoff into a completed group.
    await s.command({ op: 'finish' });
    assert.equal(s.groups.get(task.groupId).title, 'Coco Agent · 等待继续');
    if (outcome === 'stop') await s.command({ op: 'stop' });
    else
      await s.command({
        op: 'finalize',
        taskId: task.sessionId,
        keep: outcome === 'deliverable' ? [task.tabId] : [],
      });
    assert.equal(s.groups.has(task.groupId), false);
    assert.equal(s.executor.currentControl(), null);
    assert.equal(s.tabs.has(task.tabId), outcome === 'deliverable');
    if (outcome === 'deliverable') assert.equal(s.tabs.get(task.tabId).groupId, -1);
    assert.ok(s.tabs.has(1) && s.tabs.has(2));
    assert.equal(
      s.calls.some((c) => c.method === 'tabGroups.update' && /已停止|已完成/.test(c.title)),
      false,
    );
  }
});

test('failed cleanup revokes control, keeps its journal and retention decision, then retries safely', async () => {
  const s = await fixture();
  await s.executor.attach(1, 'new');
  const task = s.executor.currentControl();
  const result = await s.command({ op: 'new-tab', url: 'https://example.com/result' });
  const remove = chrome.tabs.remove;
  chrome.tabs.remove = async () => {
    throw new Error('Browser busy');
  };
  await assert.rejects(
    s.command({ op: 'finalize', taskId: task.sessionId, keep: [result.tabId] }),
    (e) => e.code === 'CLEANUP_PENDING',
  );
  assert.equal(s.executor.currentControl(), null);
  assert.equal(s.attached.size, 0);
  const journal = (await chrome.storage.local.get('taskCleanupV1')).taskCleanupV1;
  assert.equal(journal[0].pending, true);
  chrome.tabs.remove = remove;
  await s.command({ op: 'finalize', taskId: task.sessionId, keep: [] });
  assert.equal(s.tabs.has(task.tabId), false);
  assert.ok(s.tabs.has(result.tabId));
  assert.deepEqual((await chrome.storage.local.get('taskCleanupV1')).taskCleanupV1, []);
});

test('moved task tabs are handed to user; worker recovery closes only verified owned leftovers', async () => {
  const s = await fixture();
  await s.executor.attach(1, 'new');
  const task = s.executor.currentControl();
  s.tabs.get(task.tabId).groupId = -1;
  await s.executor.release();
  assert.ok(s.tabs.has(task.tabId));
  await s.executor.attach(1, 'new');
  const next = s.executor.currentControl();
  await s.executor.release(false); // Simulate lost control with a persisted task journal.
  vi.resetModules();
  const { recoverTasks } = await import('../../utils/automation/task-lifecycle');
  await recoverTasks();
  assert.equal(s.tabs.has(next.tabId), false);
  assert.ok(s.tabs.has(1) && s.tabs.has(2) && s.tabs.has(task.tabId));
});

test('browser-session change never deletes tabs based on old persisted numeric IDs', async () => {
  const s = await fixture();
  await s.executor.attach(1, 'new');
  const task = s.executor.currentControl();
  await s.executor.release(false);
  await chrome.storage.session.set({ taskBrowserNonce: 'different-browser-session' });
  vi.resetModules();
  const { recoverTasks, cleanupWarning } = await import('../../utils/automation/task-lifecycle');
  await recoverTasks();
  assert.ok(s.tabs.has(task.tabId));
  assert.ok(cleanupWarning());
});

test('recovery does not clean a newly recorded active task; finalize does not claim failed detach succeeded', async () => {
  const s = await fixture();
  await s.executor.attach(1, 'new');
  const task = s.executor.currentControl();
  await s.command({ op: 'open', url: 'https://example.com/task' });
  const { recoverTasks } = await import('../../utils/automation/task-lifecycle');
  await recoverTasks();
  assert.ok(s.tabs.has(task.tabId));
  const detach = chrome.debugger.detach;
  chrome.debugger.detach = async () => {
    throw new Error('detach failed');
  };
  await assert.rejects(
    s.command({ op: 'finalize', taskId: task.sessionId, keep: [] }),
    (e) => e.code === 'DEBUGGER_DETACH_FAILED',
  );
  assert.equal(s.executor.currentControl(), null);
  assert.ok(s.tabs.has(task.tabId));
  chrome.debugger.detach = detach;
  await s.command({ op: 'finalize', taskId: task.sessionId, keep: [] });
  assert.equal(s.tabs.has(task.tabId), false);
});

test('cancelling while creating a new tab rolls back that tab without touching user tabs', async () => {
  const s = await fixture();
  const create = chrome.tabs.create;
  chrome.tabs.create = async (props) => {
    await s.executor.release();
    return create(props);
  };
  await assert.rejects(s.executor.attach(1, 'new'), (e) => e.code === 'STOPPED');
  assert.deepEqual([...s.tabs.keys()], [1, 2]);
});

test('default new work tab stays bound in the background and never navigates the user tab', async () => {
  const s = await fixture();
  await s.executor.attach(1, 'new');
  const c = s.executor.currentControl();
  assert.equal(c.scope, 'task');
  assert.notEqual(c.tabId, 1);
  assert.equal(s.tabs.get(c.tabId).active, false);
  assert.equal(s.tabs.get(1).groupId, -1);
  assert.equal(s.groups.get(c.groupId).color, 'green');
  await s.command({ op: 'open', url: 'https://example.com/agent-work' });
  assert.equal(s.tabs.get(1).url, 'https://example.com/user-1');
  assert.equal(s.tabs.get(c.tabId).url, 'https://example.com/agent-work');
  chrome.tabs.onActivated.emit({ windowId: 1, tabId: 2 });
  const binding = await s.executor.bindCdp({
    leaseId: crypto.randomUUID(),
    controlSessionId: c.sessionId,
    deadline: Date.now() + 10000,
  });
  await s.executor.executeCdp({
    ...binding,
    type: 'cdp-command',
    id: crypto.randomUUID(),
    deadline: Date.now() + 10000,
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mousePressed', x: 100, y: 80 },
  });
  const inputCalls = s.calls.filter((call) => call.method.startsWith('Input.'));
  assert.ok(inputCalls.length > 1);
  assert.ok(inputCalls.every((call) => call.tabId === c.tabId));
  assert.equal(inputCalls.filter((call) => call.params.type === 'mousePressed').length, 1);
  assert.equal(
    s.calls.some((c) => c.method === 'tabs.update' && c.active),
    false,
  );
  assert.deepEqual(
    (await s.command({ op: 'tabs' })).tabs.map((t) => t.id),
    [c.tabId],
  );
  await s.executor.release();
});

test('group membership alone never grants access; moving the target out revokes control', async () => {
  const s = await fixture();
  await s.executor.attach(1);
  const c = s.executor.currentControl();
  s.tabs.get(2).groupId = c.groupId;
  chrome.tabs.onUpdated.emit(2, { groupId: c.groupId }, s.tabs.get(2));
  assert.deepEqual(
    (await s.command({ op: 'tabs' })).tabs.map((t) => t.id),
    [1],
  );
  await assert.rejects(
    s.command({ op: 'switch-tab', tabId: 2 }),
    (e) => e.code === 'TAB_NOT_GRANTED',
  );
  s.tabs.get(1).groupId = -1;
  chrome.tabs.onUpdated.emit(1, { groupId: -1 }, s.tabs.get(1));
  assert.equal(s.executor.currentControl(), null);
  await s.executor.release();
  assert.equal(s.attached.size, 0);
});

test('finish retains only work tabs; resume does not follow focus; closing a parked target stops', async () => {
  const s = await fixture();
  await s.executor.attach(1);
  const c = s.executor.currentControl();
  await s.command({ op: 'finish' });
  assert.equal(s.groups.get(c.groupId).title, 'Coco Agent · 等待继续');
  assert.equal(s.groups.get(c.groupId).color, 'grey');
  assert.equal(s.attached.size, 0);
  s.tabs.get(1).active = false;
  s.tabs.get(2).active = true;
  chrome.tabs.onActivated.emit({ windowId: 1, tabId: 2 });
  await s.command({ op: 'snapshot' });
  assert.equal(s.executor.currentGrant().id, 1);
  await s.command({ op: 'finish' });
  s.tabs.delete(1);
  chrome.tabs.onRemoved.emit(1);
  assert.equal(s.executor.currentControl(), null);
  await s.executor.release();
  await assert.rejects(
    s.command({ op: 'open', url: 'https://example.com/' }),
    (e) => e.code === 'CONTROL_NOT_GRANTED',
  );
  assert.equal(s.tabs.get(2).url, 'https://example.com/user-2');
});

test('additional task tabs and logical switches do not change browser focus', async () => {
  const s = await fixture();
  await s.executor.attach(1);
  const c = s.executor.currentControl();
  const created = await s.command({ op: 'new-tab', url: 'https://example.com/work-2' });
  assert.equal(s.tabs.get(created.tabId).active, false);
  assert.equal(s.tabs.get(created.tabId).groupId, c.groupId);
  assert.equal(s.executor.currentGrant().id, created.tabId);
  await s.command({ op: 'switch-tab', tabId: 1 });
  assert.equal(s.executor.currentGrant().id, 1);
  assert.equal(
    s.calls.some((c) => c.method === 'tabs.update' && c.active),
    false,
  );
  await s.executor.revealTask();
  assert.ok(s.calls.some((c) => c.method === 'tabs.update' && c.id === 1 && c.active));
  await s.executor.release();
  assert.equal(s.groups.has(c.groupId), false, 'The empty task group disappears');
  assert.equal(s.tabs.has(created.tabId), false, 'Stop closes task-created temporary pages');
});

test('stop while a new work tab is being created cannot resurrect consent', async () => {
  const s = await fixture();
  let entered, proceed;
  const started = new Promise((r) => {
    entered = r;
  });
  const continuation = new Promise((r) => {
    proceed = r;
  });
  const create = chrome.tabs.create;
  chrome.tabs.create = async (props) => {
    entered();
    await continuation;
    return create(props);
  };
  const pending = s.executor.attach(1, 'new');
  const rejected = assert.rejects(pending, (e) => e.code === 'STOPPED');
  await started;
  await s.executor.release();
  proceed();
  await rejected;
  assert.equal(s.executor.currentControl(), null);
  assert.equal(s.attached.size, 0);
});

test('additional work tabs are bounded; removing a non-target never adopts another tab', async () => {
  const s = await fixture();
  await s.executor.attach(1);
  for (let i = 0; i < 7; i++)
    await s.command({ op: 'new-tab', url: `https://example.com/work-${i}` });
  const c = s.executor.currentControl();
  await assert.rejects(
    s.command({ op: 'new-tab', url: 'https://example.com/too-many' }),
    (e) => e.code === 'TASK_TAB_LIMIT',
  );
  s.tabs.delete(1);
  chrome.tabs.onRemoved.emit(1);
  assert.equal(s.executor.currentControl().tabId, c.tabId);
  assert.equal(s.executor.currentControl().tabIds.includes(1), false);
  assert.equal(s.executor.currentControl().tabIds.includes(2), false);
  await s.executor.release();
});

test('平台首个 open 在来源窗口旁创建真实 URL，任务 ID 不重新生成', async () => {
  const s = await fixture();
  const taskId = '11111111-1111-4111-8111-111111111111';
  await s.executor.attach(1, 'new', { url: 'https://example.com/start', taskId, windowId: 1 });
  assert.deepEqual(
    s.calls.find((c) => c.method === 'tabs.create'),
    {
      method: 'tabs.create',
      windowId: 1,
      index: 1,
      openerTabId: 1,
      url: 'https://example.com/start',
      active: true,
    },
  );
  assert.equal(s.executor.currentControl().sessionId, taskId);
  await s.command({ op: 'finalize', taskId, keep: [] });
  assert.deepEqual([...s.tabs.keys()], [1, 2]);
  assert.equal(s.groups.size, 0);
});
test('来源窗口不符时首个 open 不回退当前窗口', async () => {
  const s = await fixture();
  await assert.rejects(
    s.executor.attach(1, 'new', {
      url: 'https://example.com/start',
      taskId: crypto.randomUUID(),
      windowId: 8,
    }),
  );
  assert.equal(s.calls.filter((c) => c.method === 'tabs.create').length, 0);
});
