import { z } from 'zod';
import type { TranslationKey } from './i18n';

export const AGENT_ACTIVITY_CAPABILITY = 'agent-activity-v1';
export const AGENT_HISTORY_CAPABILITY = 'agent-history-v1';
export const AGENT_ACTIVITY_TTL_MS = 30_000;
const activityFields = {
  category: z.enum([
    'idle',
    'processing',
    'command',
    'read',
    'write',
    'search',
    'web',
    'image',
    'delegate',
    'waiting',
    'tool',
  ]),
  phase: z.enum(['returned']).optional(),
  detail: z
    .enum([
      'node',
      'npm',
      'pnpm',
      'python',
      'python3',
      'rg',
      'cat',
      'sed',
      'ls',
      'git',
      'curl',
      'bash',
      'sh',
    ])
    .optional(),
};
export const agentEventSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().min(1).max(256),
    kind: z.literal('commentary'),
    at: z.number().finite().nonnegative(),
    text: z.string().min(1).max(2000),
  }),
  z.object({
    id: z.string().min(1).max(256),
    kind: z.literal('tool'),
    at: z.number().finite().nonnegative(),
    endedAt: z.number().finite().nonnegative().optional(),
    category: activityFields.category,
    detail: activityFields.detail,
    tool: z
      .string()
      .regex(/^[\w.:-]{1,120}$/)
      .optional(),
  }),
]);
export const agentHistorySchema = z.object({
  status: z.enum(['running', 'completed', 'stopped', 'interrupted']),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  events: z.array(agentEventSchema).max(500),
  dropped: z.number().int().nonnegative().default(0),
});
export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentHistory = z.infer<typeof agentHistorySchema>;
export const agentActivityFrameSchema = z.object({
  type: z.literal('agent-activity'),
  endpointId: z.string().min(1).max(80),
  taskId: z.string().min(1).max(128),
  sequence: z.number().int().positive().safe(),
  ...activityFields,
  events: z.array(agentEventSchema).max(100).optional(),
  dropped: z.number().int().nonnegative().max(100000).optional(),
});
export const agentActivitySchema = agentActivityFrameSchema
  .omit({ type: true, events: true, dropped: true })
  .extend({ receivedAt: z.number() });
export type AgentActivity = z.infer<typeof agentActivitySchema>;

export function appendAgentEvents(history: AgentHistory, events: AgentEvent[], dropped = 0) {
  const byId = new Map(history.events.map((event) => [event.id, event]));
  for (const event of events) byId.set(event.id, event);
  history.events = [...byId.values()].sort((a, b) => a.at - b.at);
  history.dropped += dropped;
  if (history.events.length > 500) {
    history.dropped += history.events.length - 500;
    history.events.splice(0, history.events.length - 500);
  }
}

// Bound local history without limiting task duration or the number of actions.
export function pruneAgentHistory(chat: { agentHistory?: AgentHistory }[]) {
  const histories = chat.flatMap((entry) => (entry.agentHistory ? [entry.agentHistory] : []));
  const size = (event: AgentEvent) => (event.kind === 'commentary' ? event.text.length : 0);
  let count = histories.reduce((n, h) => n + h.events.length, 0);
  let chars = histories.reduce((n, h) => n + h.events.reduce((sum, e) => sum + size(e), 0), 0);
  for (const history of histories) {
    let remove = 0;
    while (remove < history.events.length && (count > 1000 || chars > 500_000)) {
      chars -= size(history.events[remove++]!);
      count--;
    }
    history.events.splice(0, remove);
    history.dropped += remove;
  }
}
export const agentActivityLabels: Record<AgentActivity['category'], TranslationKey> = {
  idle: 'progressWorking',
  processing: 'agentProcessing',
  command: 'agentCommand',
  read: 'agentRead',
  write: 'agentWrite',
  search: 'agentSearch',
  web: 'agentWeb',
  image: 'agentImage',
  delegate: 'agentDelegate',
  waiting: 'agentWaiting',
  tool: 'agentTool',
};
