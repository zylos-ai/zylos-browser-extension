// Follow-up replies to an ended task (zylos-browser-remote#7). The relay only
// correlates; this module decides from the persisted chat history whether the
// task may still receive one, so the limits survive relay and worker restarts.
import { z } from 'zod';
import { MAX_CHAT_TEXT, type ChatEntry } from './remote';

export const AGENT_TASK_APPEND_CAPABILITY = 'agent-task-append-v1';
export const TASK_APPEND_WINDOW_MS = 24 * 60 * 60 * 1000;
export const TASK_APPEND_LIMIT = 20;

export const taskAppendSchema = z
  .object({
    taskId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    appendId: z.string().regex(/^[a-f0-9]{32}$/),
    text: z
      .string()
      .max(MAX_CHAT_TEXT)
      .refine((value) => !!value.trim()),
  })
  .strict();
export type TaskAppend = z.infer<typeof taskAppendSchema>;
export type TaskAppendResult = {
  taskId: string;
  appendId: string;
  status: 'appended' | 'existing';
  count: number;
  limit: number;
};

export function taskAppendError(code: string) {
  return Object.assign(new Error(code), { code });
}

export const appendEntryId = (appendId: string) => `append:${appendId}`;

/**
 * Decide whether `input` may be appended. Returns the entry to store (absent
 * when the same follow-up is already shown) and the resulting follow-up count.
 * Throws with a fixed code otherwise; the relay passes the code to the Agent.
 */
export function planTaskAppend(
  chat: readonly ChatEntry[],
  input: TaskAppend,
  { now, activeTaskId }: { now: number; activeTaskId?: string },
): { entry?: ChatEntry; result: TaskAppendResult } {
  const task = chat.find((entry) => entry.role === 'user' && entry.id === input.taskId);
  if (!task) throw taskAppendError('TASK_UNKNOWN');
  if (activeTaskId === input.taskId || !task.loopStatus || task.loopStatus === 'active')
    throw taskAppendError('TASK_ACTIVE');
  // Only a task the Agent itself answered; never one the owner stopped.
  if (task.loopStatus !== 'done' && task.loopStatus !== 'blocked')
    throw taskAppendError('TASK_NOT_APPENDABLE');
  const followUps = chat.filter(
    (entry) => entry.role === 'assistant' && entry.followUp && entry.taskId === input.taskId,
  );
  const id = appendEntryId(input.appendId);
  const existing = followUps.find((entry) => entry.id === id);
  const text = input.text.trim();
  const result = (status: TaskAppendResult['status'], count: number): TaskAppendResult => ({
    taskId: input.taskId,
    appendId: input.appendId,
    status,
    count,
    limit: TASK_APPEND_LIMIT,
  });
  if (existing) {
    if (existing.text !== text) throw taskAppendError('TASK_APPEND_CONFLICT');
    return { result: result('existing', followUps.indexOf(existing) + 1) };
  }
  // Older histories may lack endedAt; their start time is the conservative bound.
  const endedAt = task.agentHistory?.endedAt ?? task.ts;
  if (now - endedAt > TASK_APPEND_WINDOW_MS) throw taskAppendError('TASK_TOO_OLD');
  if (followUps.length >= TASK_APPEND_LIMIT) throw taskAppendError('TASK_APPEND_LIMIT');
  return {
    entry: {
      id,
      role: 'assistant',
      text,
      final: true,
      followUp: true,
      taskId: input.taskId,
      ts: now,
    },
    result: result('appended', followUps.length + 1),
  };
}
