import { z } from 'zod';
import type { TranslationKey } from './i18n';

export const AGENT_ACTIVITY_CAPABILITY = 'agent-activity-v1';
export const AGENT_ACTIVITY_TTL_MS = 30_000;
export const agentActivityFrameSchema = z.object({
  type: z.literal('agent-activity'),
  endpointId: z.string().min(1).max(80),
  taskId: z.string().min(1).max(128),
  sequence: z.number().int().positive().safe(),
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
});
export const agentActivitySchema = agentActivityFrameSchema
  .omit({ type: true })
  .extend({ receivedAt: z.number() });
export type AgentActivity = z.infer<typeof agentActivitySchema>;
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
