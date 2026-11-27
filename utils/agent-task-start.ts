import { z } from 'zod';
import { BROWSER_ID_RE } from './remote';
import { canReadPage } from './page-reader';
import { isSiteUrlBlocked, recordSiteAccess } from './site-access';

export async function waitForTaskPage<T extends { context: { contextId?: string } }>(
  tabId: number,
  windowId: number,
  assertActive: () => void,
  capture: () => Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertActive();
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    assertActive();
    if (!tab || tab.id !== tabId || tab.windowId !== windowId || tab.incognito)
      throw taskStartError('TASK_START_REVOKED');
    if (tab.status === 'complete' && !tab.pendingUrl) {
      if (!canReadPage(tab)) throw taskStartError('PAGE_UNAVAILABLE');
      const result = await capture();
      assertActive();
      if (Date.now() >= deadline) break;
      // Capture can race a redirect. Retry only this owned tab, never recreate it.
      if (result.context.contextId) return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assertActive();
  throw taskStartError('TASK_START_PAGE_TIMEOUT');
}

/**
 * Why the Agent may not start on this tab. These are the checks a panel message
 * gets (restricted pages, private windows, site access rules), turned into
 * explicit refusals: an agent start never borrows a page it could not read.
 */
export function currentTabRefusal(tab: chrome.tabs.Tab | undefined): string | undefined {
  if (!tab || tab.id === undefined) return 'TASK_START_NO_TAB';
  if (canReadPage(tab)) return;
  if (tab.incognito) return 'TASK_START_PAGE_RESTRICTED';
  if (tab.pendingUrl) return 'TASK_START_PAGE_NOT_READY';
  // Browser pages, the Web Store and credentialed URLs are restricted by nature;
  // only an ordinary web page can be denied by the owner's site rules.
  let url: URL;
  try {
    url = new URL(tab.url || '');
  } catch {
    return 'TASK_START_PAGE_RESTRICTED';
  }
  if (['http:', 'https:'].includes(url.protocol) && isSiteUrlBlocked(url.href))
    return 'TASK_START_SITE_DENIED';
  return 'TASK_START_PAGE_RESTRICTED';
}

/**
 * Pins the tab the user had in front of them when the start arrived. Capture
 * runs the same document-pinned path as a panel message; the tab is then
 * re-read so a close, navigation, reload or move during the start is refused
 * with its own reason instead of silently following the tab elsewhere.
 */
export async function captureStartTab<
  T extends { context: { contextId?: string; tabId?: number; reason?: string } },
>(
  tab: chrome.tabs.Tab | undefined,
  windowId: number,
  assertActive: () => void,
  capture: (tabId: number) => Promise<T>,
): Promise<T> {
  const refusal = currentTabRefusal(tab);
  if (refusal) {
    if (refusal === 'TASK_START_SITE_DENIED' && tab?.url)
      await recordSiteAccess(tab.url, 'use-current-tab', false).catch(() => {});
    assertActive();
    throw taskStartError(refusal);
  }
  const tabId = tab!.id!;
  const result = await capture(tabId);
  assertActive();
  const fresh = await chrome.tabs.get(tabId).catch(() => null);
  assertActive();
  if (!fresh || fresh.id !== tabId) throw taskStartError('TASK_START_TAB_CLOSED');
  if (
    fresh.windowId !== windowId ||
    fresh.url !== tab!.url ||
    fresh.pendingUrl ||
    result.context.reason === 'PAGE_CHANGED' ||
    (result.context.tabId !== undefined && result.context.tabId !== tabId)
  )
    throw taskStartError('TASK_START_PAGE_CHANGED');
  // Same page, but the owner's rules may have changed while it was captured.
  const now = currentTabRefusal(fresh);
  if (now) throw taskStartError(now);
  if (!result.context.contextId) throw taskStartError('TASK_START_PAGE_NOT_READY');
  return result;
}

export const AGENT_TASK_START_CAPABILITY = 'agent-task-start-v1';
/** The Agent may start on the user's current tab (`target: 'current-tab'`). */
export const AGENT_TASK_CURRENT_TAB_CAPABILITY = 'agent-task-current-tab-v1';
const startBase = {
  requestId: z.string().regex(BROWSER_ID_RE),
  prompt: z
    .string()
    .max(8000)
    .refine((value) => !!value.trim()),
};
const urlStartSchema = z
  .object({
    ...startBase,
    url: z
      .string()
      .max(4096)
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !/[\s\u0000-\u001f\u007f]/.test(value)
        );
      }),
  })
  .strict();
const currentTabStartSchema = z.object({ ...startBase, target: z.literal('current-tab') }).strict();
export const taskStartSchema = z.union([urlStartSchema, currentTabStartSchema]);
export type TaskStart = z.infer<typeof taskStartSchema>;
export type TaskStartResult = { requestId: string; taskId: string; status: 'started' | 'existing' };
export function taskStartError(code: string) {
  return Object.assign(new Error(code), { code });
}

// Retain failures as well as successes: an uncertain outcome must never create
// another tab. This ledger and its grant deliberately share a worker lifetime.
export class TaskStartLedger {
  private entries = new Map<string, { signature: string; result: Promise<TaskStartResult> }>();
  run(input: TaskStart, work: () => Promise<TaskStartResult>): Promise<TaskStartResult> {
    const signature = JSON.stringify(
      'url' in input ? [input.prompt, input.url] : [input.prompt, { target: input.target }],
    );
    const previous = this.entries.get(input.requestId);
    if (previous) {
      if (previous.signature !== signature)
        return Promise.reject(taskStartError('TASK_START_CONFLICT'));
      return previous.result.then((result) => ({ ...result, status: 'existing' }));
    }
    if (this.entries.size >= 256) return Promise.reject(taskStartError('TASK_START_CONFLICT'));
    const result = Promise.resolve().then(work);
    this.entries.set(input.requestId, { signature, result });
    return result;
  }
}
