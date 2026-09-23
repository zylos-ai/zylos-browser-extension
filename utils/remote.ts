// zylos-remote transport: shared constants, storage shapes and panel messages.
//
// The extension dials out to a zylos-browser-remote relay with `relayUrl + key`
// and nothing else. The relay is a pipe; every safety decision is made here.
import { z } from 'zod';
import { agentActivityFrameSchema, agentActivitySchema } from './agent-activity';
import { pageSelectionSchema } from './page-selection';
import { storedAttachmentsSchema, selectionAttachment } from './attachments';
import { userMessageSchema } from './agent-message';
import { taskNoticeSchema } from './task-notice';

export const REMOTE_SUBPROTOCOL = 'zylos-browser-remote.v3';
export const REMOTE_KEY_PROTO_PREFIX = 'key.';
export const REMOTE_VERSION = '1.5.0';
export const MAX_CHAT_TEXT = 8000;
export const CHAT_LOG_CAP = 200;
export const REPLY_NOTICE_MS = 120_000;

// '' means "not configured yet"; anything else must be well-formed.
export const remoteConfigSchema = z.object({
  relayUrl: z
    .union([z.literal(''), z.string().regex(/^wss?:\/\/[^\s]+$/, 'ui.error.invalidRelayUrl')])
    .default(''),
  key: z
    .union([z.literal(''), z.string().regex(/^[a-f0-9]{32,128}$/, 'ui.error.invalidKey')])
    .default(''),
  enabled: z.boolean().default(true),
});
export type RemoteConfig = z.infer<typeof remoteConfigSchema>;
export const REMOTE_CONFIG_KEY = 'remoteConfig';
// One random identity per installation/profile. Never sync it between devices.
export const REMOTE_BROWSER_ID_KEY = 'remoteBrowserId';
export const INSTANCE_CAPABILITY = 'browser-instance-v1';
export const INTERRUPT_CAPABILITY = 'agent-interrupt-v1';
export const BROWSER_ID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const REMOTE_CHAT_LOG_KEY = 'remoteChatLog';

// Keep tool history small: never persist raw arguments, page output or images.
export const TOOL_STEPS_CAP = 200;
export const toolStepSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  method: z.string().max(128),
  target: z.string().max(240).optional(),
  // Optional user-facing phase description; never copied from Agent memory.
  summary: z.string().max(160).optional(),
  status: z.enum(['queued', 'running', 'success', 'error', 'cancelled', 'interrupted']),
  queuedAt: z.number(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  errorCode: z.string().max(64).optional(),
  replayed: z.boolean().optional(),
  recovered: z.boolean().optional(),
});
export const toolRunSchema = z.object({
  status: z.enum(['running', 'completed', 'stopped', 'interrupted']),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  total: z.number().int(),
  failed: z.number().int(),
  recovered: z.number().int().nonnegative().optional(),
  steps: z.array(toolStepSchema).max(TOOL_STEPS_CAP),
});
export type ToolStep = z.infer<typeof toolStepSchema>;
export type ToolRun = z.infer<typeof toolRunSchema>;

export const chatEntrySchema = z
  .object({
    id: z.string().max(128).optional(),
    role: z.enum(['user', 'assistant', 'system']),
    text: z.string().max(MAX_CHAT_TEXT),
    notice: taskNoticeSchema.optional(),
    ts: z.number().int(),
    delivery: z.enum(['sent', 'queued', 'failed', 'unknown']).optional(),
    deliveryError: z.string().optional(),
    final: z.boolean().optional(),
    loopStatus: z.enum(['active', 'done', 'blocked', 'interrupted', 'stopped']).optional(),
    page: z.object({ title: z.string(), url: z.string(), status: z.string() }).optional(),
    selection: pageSelectionSchema.optional(),
    attachments: storedAttachmentsSchema.optional(),
    toolRun: toolRunSchema.optional(),
  })
  .transform(({ selection, ...entry }) => ({
    ...entry,
    // Read old local histories once; all new messages use attachments exclusively.
    ...(entry.attachments
      ? {}
      : selection
        ? {
            attachments: [
              selectionAttachment(
                selection,
                `${String(entry.id || entry.ts).slice(0, 100)}-selection`,
              ),
            ],
          }
        : {}),
  }));
export type ChatEntry = z.infer<typeof chatEntrySchema>;

export const remoteStateSchema = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  connected: z.boolean(),
  connecting: z.boolean(),
  error: z.string(),
  keyId: z.string(),
  browserId: z.string().default(''),
  endpointId: z.string().default(''),
  relayHost: z.string(),
  relayUrl: z.string(),
  agentActivity: agentActivitySchema.optional(),
  loopActive: z.boolean().optional(),
  chatBusy: z.boolean().optional(),
  stopping: z.boolean().optional(),
  task: z
    .object({
      sessionId: z.string(),
      phase: z.enum(['running', 'ready', 'paused', 'finished']),
      tabId: z.number().int(),
      tabCount: z.number().int(),
      url: z.string(),
      title: z.string(),
    })
    .nullable(),
  chat: z.array(chatEntrySchema),
});
export type RemoteState = z.infer<typeof remoteStateSchema>;

export const initialRemoteState: RemoteState = {
  configured: false,
  enabled: true,
  connected: false,
  connecting: false,
  error: '',
  keyId: '',
  browserId: '',
  endpointId: '',
  relayHost: '',
  relayUrl: '',
  task: null,
  chat: [],
};

// Panel -> background. Only the bundled sidepanel may send these.
export const remoteRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('remote-state') }).strict(),
  z.object({ type: z.literal('remote-save'), relayUrl: z.string(), key: z.string() }).strict(),
  z.object({ type: z.literal('remote-set-enabled'), enabled: z.boolean() }).strict(),
  z
    .object({
      type: z.literal('remote-chat-send'),
      message: userMessageSchema,
      windowId: z.number().int().nonnegative().optional(),
      tabId: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ type: z.literal('remote-chat-clear') }).strict(),
  z.object({ type: z.literal('remote-reveal') }).strict(),
  z.object({ type: z.literal('remote-preview-reveal') }).strict(),
  z.object({ type: z.literal('remote-stop') }).strict(),
]);
export type RemoteRequest = z.infer<typeof remoteRequestSchema>;

// Relay -> extension frames.
export const relayFrameSchema = z.discriminatedUnion('type', [
  agentActivityFrameSchema,
  z.object({
    type: z.literal('agent-stop-result'),
    taskId: z.string().min(1).max(128),
    ok: z.boolean(),
    code: z.string().max(128).optional(),
  }),
  z.object({
    type: z.literal('ready'),
    capabilities: z.array(z.string()).max(32),
    endpointId: z.string().max(80).optional(),
  }),
  z.object({
    type: z.literal('agent-status'),
    requestId: z.string().max(128),
    state: z.string(),
    code: z.string().optional(),
  }),
  z.object({ type: z.literal('ping'), ts: z.number().optional() }),
  z.object({
    type: z.literal('req'),
    id: z.number().int(),
    method: z.string().max(128),
    params: z.record(z.unknown()).default({}),
    requestId: z.string().max(128).optional(),
    deadline: z.number().int().optional(),
  }),
]);
export type RelayFrame = z.infer<typeof relayFrameSchema>;

/** keyId = first 12 hex of sha256(key); the relay derives the same value. */
export async function keyIdOf(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
}

export function relayHostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
