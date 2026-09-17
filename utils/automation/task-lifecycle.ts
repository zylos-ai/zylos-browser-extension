import { z } from 'zod';

const recordSchema = z.object({
  taskId: z.string().uuid(),
  browser: z.string(),
  windowId: z.number().int(),
  groupId: z.number().int().nullable(),
  pending: z.boolean(),
  tabs: z.array(z.object({ id: z.number().int(), owned: z.boolean(), keep: z.boolean() })),
});
type Record = z.infer<typeof recordSchema>;
const key = 'taskCleanupV1';
const records = new Map<string, Record>();
const receipts = new Map<string, unknown>();
let browser = '';
let loaded: Promise<void> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let warning = '';
export const cleanupWarning = () => warning;
function serial<T>(work: () => Promise<T>) {
  const next = queue.catch(() => {}).then(work);
  queue = next.catch(() => {});
  return next;
}
function refreshWarning() {
  warning = [...records.values()].some((r) => r.pending || r.browser !== browser)
    ? '部分工作标签尚未清理；控制已撤销。无法核验归属的旧标签请手动关闭。'
    : '';
}
async function load() {
  if (!loaded)
    loaded = (async () => {
      const session = await chrome.storage.session.get('taskBrowserNonce');
      browser =
        typeof session.taskBrowserNonce === 'string'
          ? session.taskBrowserNonce
          : crypto.randomUUID();
      await chrome.storage.session.set({ taskBrowserNonce: browser });
      const stored = await chrome.storage.local.get(key);
      const parsed = z
        .array(recordSchema)
        .max(100)
        .safeParse(stored[key] ?? []);
      if (!parsed.success) throw new Error('Invalid task cleanup journal');
      for (const r of parsed.data) records.set(r.taskId, { ...r, pending: true });
      refreshWarning();
    })();
  await loaded;
}
async function save() {
  await chrome.storage.local.set({ [key]: [...records.values()] });
  refreshWarning();
}
export async function recordTask(
  taskId: string,
  windowId: number,
  groupId: number | null,
  id: number,
  owned: boolean,
) {
  await serial(async () => {
    await load();
    if (records.size >= 100 && !records.has(taskId))
      throw new Error('Too many pending cleanup tasks');
    let r = records.get(taskId);
    if (!r) {
      r = { taskId, browser, windowId, groupId, pending: false, tabs: [] };
      records.set(taskId, r);
    }
    if (r.pending) throw new Error('Task already ended');
    r.groupId = groupId;
    if (!r.tabs.some((t) => t.id === id)) r.tabs.push({ id, owned, keep: false });
    await save();
  });
}
export async function cleanupTask(taskId: string, keep: number[] = [], recovery = false) {
  return serial(async () => {
    await load();
    if (receipts.has(taskId)) return receipts.get(taskId);
    const r = records.get(taskId);
    if (!r) throw Object.assign(new Error('Unknown or expired task'), { code: 'STALE_TASK' });
    if (keep.some((id) => !r.tabs.some((t) => t.id === id)))
      throw Object.assign(new Error('Cannot retain another task tab'), { code: 'TAB_NOT_GRANTED' });
    r.pending = true;
    for (const t of r.tabs) if (keep.includes(t.id)) t.keep = true;
    await save(); // Persist the keep decision before any destructive operation.
    if (
      (r.browser !== browser || (recovery && r.groupId === null)) &&
      r.tabs.some((t) => t.owned)
    ) {
      throw Object.assign(new Error(warning), { code: 'CLEANUP_PENDING' });
    }
    const closed: number[] = [],
      retained: number[] = [],
      handedOff: number[] = [];
    const remaining: typeof r.tabs = [];
    // A failed query is not evidence of a closed tab.
    const existing = await chrome.tabs.query({ windowId: r.windowId });
    for (const t of r.tabs) {
      const tab = existing.find((v) => v.id === t.id);
      if (!tab) continue;
      // Borrowed user pages keep their original group and lifetime, even on stop/recovery.
      if (!t.owned) {
        retained.push(t.id);
        continue;
      }
      if (tab.windowId !== r.windowId || (r.groupId !== null && tab.groupId !== r.groupId)) {
        handedOff.push(t.id);
        continue; // User moved it: relinquish ownership, never chase it.
      }
      try {
        // Recheck immediately before closing; ignore group members not in our journal.
        const fresh = await chrome.tabs.get(t.id);
        if (fresh.windowId !== r.windowId || (r.groupId !== null && fresh.groupId !== r.groupId)) {
          handedOff.push(t.id);
          continue;
        }
        if (t.owned && !t.keep) {
          await chrome.tabs.remove(t.id);
          closed.push(t.id);
        } else {
          if (fresh.groupId !== -1) await chrome.tabs.ungroup(t.id);
          retained.push(t.id);
        }
      } catch {
        remaining.push(t);
      }
    }
    r.tabs = remaining;
    if (!remaining.length) records.delete(taskId);
    await save();
    if (remaining.length) throw Object.assign(new Error(warning), { code: 'CLEANUP_PENDING' });
    const receipt = { finalized: true, taskId, closed, retained, handedOff };
    receipts.set(taskId, receipt);
    if (receipts.size > 32) receipts.delete(receipts.keys().next().value!);
    return receipt;
  });
}
export async function recoverTasks(activeTask?: string) {
  await load();
  for (const r of [...records.values()]) {
    if (r.taskId === activeTask || !r.pending) continue;
    try {
      await cleanupTask(r.taskId, [], true);
    } catch {
      /* Remains journaled; never restore control. */
    }
  }
  refreshWarning();
}
