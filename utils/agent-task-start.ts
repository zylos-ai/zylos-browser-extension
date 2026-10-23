import { z } from 'zod';
import { BROWSER_ID_RE } from './remote';
import { canReadPage } from './page-reader';

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

export const AGENT_TASK_START_CAPABILITY = 'agent-task-start-v1';
export const taskStartSchema = z
  .object({
    requestId: z.string().regex(BROWSER_ID_RE),
    prompt: z
      .string()
      .max(8000)
      .refine((value) => !!value.trim()),
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
    const signature = JSON.stringify([input.prompt, input.url]);
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
