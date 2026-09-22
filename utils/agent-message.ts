import { z } from 'zod';
import {
  attachmentSchema,
  attachmentsSchema,
  agentAttachments,
  type Attachment,
} from './attachments';

export const AGENT_MESSAGE_VERSION = 2;
export const AGENT_MESSAGE_CAPABILITY = 'agent-message-v2';
export const MAX_MESSAGE_TEXT = 8000;
const textContentSchema = z
  .object({ type: z.literal('text'), text: z.string().max(MAX_MESSAGE_TEXT) })
  .strict();
export const userMessageSchema = z
  .object({
    role: z.literal('user'),
    content: z
      .array(z.union([textContentSchema, attachmentSchema]))
      .min(1)
      .max(16),
  })
  .strict()
  .superRefine((message, ctx) => {
    const text = messageText(message);
    if (!text.trim() || text.length > MAX_MESSAGE_TEXT)
      ctx.addIssue({ code: 'custom', message: 'User text must contain 1–8000 characters' });
    const attachments = attachmentsSchema.safeParse(messageAttachments(message));
    if (!attachments.success)
      ctx.addIssue({ code: 'custom', message: 'Invalid message attachments' });
  });
export type UserMessage = z.infer<typeof userMessageSchema>;
type MessageBody = { content: ({ type: 'text'; text: string } | Attachment)[] };
export const messageText = (message: MessageBody) =>
  message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
export const messageAttachments = (message: MessageBody) =>
  message.content.filter((part): part is Attachment => part.type !== 'text');
export function agentMessage(id: string, message: UserMessage) {
  return {
    id,
    role: message.role,
    content: message.content.map((part) =>
      part.type === 'text' ? part : agentAttachments([part], id)[0]!,
    ),
  };
}

export type PageContext = {
  type: 'current-page';
  status: 'excerpt' | 'unavailable';
  contextId?: string;
  tabId?: number;
  url?: string;
  title?: string;
  capturedAt?: string;
  reason?: string;
  text?: string;
  links?: { text: string; url: string }[];
  contentVersion?: string;
  nextOffset?: number | null;
  limited?: boolean;
  truncated?: boolean;
  scope?: string;
};
export type AgentRequest = {
  version: typeof AGENT_MESSAGE_VERSION;
  id: string;
  taskId: string;
  round: number;
  // Content is sent once; subsequent rounds refer to the same owner message.
  message: ReturnType<typeof agentMessage> | { id: string };
  context: { pages: PageContext[] };
  execution: {
    protocol: 'browser-decision-v1';
    mode: 'reading' | 'operating';
    instructions?: string;
    tools?: unknown[];
    memory: string;
    notice: string;
    observation?: unknown;
    results?: unknown[];
    failed?: boolean;
  };
};
