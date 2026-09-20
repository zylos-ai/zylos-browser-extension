import {
  browserPageVersion,
  currentControl,
  currentGrant,
  flushTaskPopups,
  taskPopupOpener,
} from './automation/executor';
import type { LoopAction, RoundResult } from './browser-loop';

type Call = (
  method: string,
  params: Record<string, unknown>,
  requestId: string,
) => Promise<unknown>;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const reads = new Set(['find', 'inspect', 'frames', 'observe']);
const navigations = new Set([
  'open',
  'new-tab',
  'back',
  'forward',
  'reload',
  'switch-tab',
  'use-current-tab',
]);
function errorInfo(error: unknown) {
  const e = error as { code?: string; message?: string };
  return { code: e?.code || 'BROWSER_ERROR', message: String(e?.message || error).slice(0, 1000) };
}

// Mechanical browser state transitions belong here, never in the model prompt
// or relay. Reads can retry after navigation; mutations are issued exactly once.
export async function runBrowserRound(
  actions: LoopAction[],
  call: Call,
  assertActive: () => void,
  requestId: string,
): Promise<RoundResult> {
  // A standalone DOM read is already its own observation. In particular, it
  // must not fall through to CDP snapshot/settle/tabs or establish task control.
  if (actions.length === 1 && actions[0]!.method === 'read-page') {
    const action = actions[0]!;
    assertActive();
    try {
      const page = await call(action.method, action.params, `${requestId}:0`);
      assertActive();
      return {
        mode: currentControl() ? 'operating' : 'reading',
        observation: { page },
        results: [
          { method: 'read-page', status: 'success', result: { includedInObservation: true } },
        ],
        failed: false,
      };
    } catch (error) {
      assertActive();
      if (errorInfo(error).code === 'STOPPED') throw error;
      return {
        mode: currentControl() ? 'operating' : 'reading',
        observation: { available: false, error: errorInfo(error) },
        results: [{ method: 'read-page', status: 'error', error: errorInfo(error) }],
        failed: true,
      };
    }
  }
  const results: unknown[] = [];
  let failed = false;
  let suppliedObservation: unknown;
  for (let i = 0; i < actions.length; i++) {
    assertActive();
    const action = actions[i]!;
    const before = currentControl();
    const version = browserPageVersion();
    let actionCompleted = false;
    try {
      const result = await call(action.method, action.params, `${requestId}:${i}`);
      assertActive();
      actionCompleted = true;
      results.push({
        method: action.method,
        status: 'success',
        result: reads.has(action.method) ? { includedInObservation: true } : result,
      });
      if (reads.has(action.method)) suppliedObservation = result;
      else if (
        navigations.has(action.method) ||
        ['click', 'keypress', 'scroll', 'check', 'select', 'hover'].includes(action.method)
      ) {
        const settled = await settle(before, action.method, call, assertActive, requestId);
        results.push({ method: 'settle', ...settled });
      }
    } catch (error) {
      assertActive();
      if (['STOPPED', 'TASK_TAB_UNAVAILABLE'].includes(errorInfo(error).code)) throw error;
      failed = true;
      results.push({
        method: actionCompleted ? 'settle' : action.method,
        status: 'error',
        error: errorInfo(error),
      });
      break;
    }
    if (browserPageVersion() !== version && i + 1 < actions.length) {
      results.push({
        status: 'skipped',
        count: actions.length - i - 1,
        reason: 'Page changed; remaining actions need a fresh decision.',
      });
      break;
    }
  }
  assertActive();
  if (!currentControl())
    return {
      mode: 'reading',
      observation: { available: false, reason: 'No selected task page' },
      results,
      failed,
    };
  let observation: unknown = suppliedObservation;
  // find/inspect refs remain valid: do not clear them with a redundant snapshot.
  if (observation === undefined) {
    for (let attempt = 0; attempt < 3; attempt++) {
      assertActive();
      try {
        observation = await call('snapshot', { viewport: true }, `${requestId}:state:${attempt}`);
        break;
      } catch (error) {
        const info = errorInfo(error);
        if (['PAGE_CHANGED', 'PAGE_LOADING'].includes(info.code) && attempt < 2) {
          await delay(200);
          continue;
        }
        observation = { available: false, error: info };
        failed = true;
      }
    }
  }
  assertActive();
  const tabs = await call('tabs', {}, `${requestId}:tabs`);
  assertActive();
  // Cap page text before transport; retain attachment data for the Agent host.
  let remaining = 20000;
  const bounded = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const allowed = Math.max(0, Math.min(remaining, 12000));
      remaining -= Math.min(allowed, value.length);
      if (value.length <= allowed) return value;
      const part = value.slice(0, allowed);
      return (
        part.slice(0, Math.max(0, part.lastIndexOf('\n'))) +
        '\n[truncated; use targeted find/inspect or scroll]'
      );
    }
    if (Array.isArray(value)) return value.slice(0, 100).map(bounded);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, key === 'data' ? item : bounded(item)]),
    );
  };
  return {
    mode: 'operating',
    observation: { page: bounded(observation), tabs, target: currentGrant() },
    results: results.map(bounded),
    failed,
  };
}

async function settle(
  before: ReturnType<typeof currentControl>,
  method: string,
  call: Call,
  assertActive: () => void,
  requestId: string,
) {
  const started = Date.now();
  const initial = currentControl();
  if (!initial) return { status: 'unavailable' };
  let selectedPopup = false;
  let last = '',
    quietSince = started;
  // Brief grace for delayed redirects/popups; no invented URL or mandatory
  // navigation. An unchanged loaded page is a valid in-page interaction.
  const grace = ['click', 'keypress', 'check', 'select', 'hover'].includes(method) ? 650 : 250;
  while (Date.now() - started < 8000) {
    assertActive();
    await flushTaskPopups();
    assertActive();
    const control = currentControl();
    if (!control || control.sessionId !== initial.sessionId)
      throw Object.assign(new Error('Task stopped'), { code: 'STOPPED' });
    if (before && !selectedPopup && ['click', 'keypress'].includes(method)) {
      const added = control.tabIds.filter((id) => !before.tabIds.includes(id));
      const candidates = (
        await Promise.all(added.map((id) => chrome.tabs.get(id).catch(() => null)))
      ).filter(
        (tab) =>
          tab && taskPopupOpener(tab.id!) === before.tabId && tab.url && tab.url !== 'about:blank',
      );
      assertActive();
      if (candidates.length > 1)
        return {
          status: 'multiple-new-tabs',
          note: 'Choose an observed task tab; no popup was selected automatically.',
        };
      if (candidates.length === 1) {
        await call('switch-tab', { tabId: candidates[0]!.id }, `${requestId}:popup`);
        selectedPopup = true;
        quietSince = Date.now();
      }
    }
    assertActive();
    const tab = await chrome.tabs.get(currentControl()!.tabId);
    assertActive();
    const state = JSON.stringify([
      tab.id,
      tab.url,
      tab.pendingUrl,
      tab.status,
      browserPageVersion(),
    ]);
    if (state !== last) {
      last = state;
      quietSince = Date.now();
    }
    if (
      tab.status === 'complete' &&
      !tab.pendingUrl &&
      Date.now() - started >= grace &&
      Date.now() - quietSince >= 200
    )
      return {
        status: 'ready',
        tabId: tab.id,
        url: tab.url,
        selectedPopup,
        durationMs: Date.now() - started,
      };
    await delay(100);
  }
  return {
    status: 'loading',
    note: 'Load settling budget reached; inspect current evidence, do not repeat the preceding action.',
    durationMs: Date.now() - started,
  };
}
