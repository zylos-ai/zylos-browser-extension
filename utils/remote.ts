// zylos-remote transport: shared constants, storage shapes and panel messages.
//
// The extension dials out to a zylos-browser-remote relay with `relayUrl + key`
// and nothing else. The relay is a pipe; every safety decision is made here.
import { z } from 'zod';

export const REMOTE_SUBPROTOCOL = 'zylos-browser-remote.v2';
export const REMOTE_KEY_PROTO_PREFIX = 'key.';
export const REMOTE_VERSION = '1.2.0';
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
export const REMOTE_CHAT_LOG_KEY = 'remoteChatLog';

export const chatEntrySchema = z.object({
  id: z.string().max(128).optional(),
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string().max(MAX_CHAT_TEXT),
  ts: z.number().int(),
  delivery: z.enum(['sent', 'queued', 'failed', 'unknown']).optional(),
  deliveryError: z.string().optional(),
  final: z.boolean().optional(),
});
export type ChatEntry = z.infer<typeof chatEntrySchema>;

export const remoteStateSchema = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  connected: z.boolean(),
  connecting: z.boolean(),
  error: z.string(),
  keyId: z.string(),
  relayHost: z.string(),
  relayUrl: z.string(),
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
    .object({ type: z.literal('remote-chat-send'), text: z.string().min(1).max(MAX_CHAT_TEXT) })
    .strict(),
  z.object({ type: z.literal('remote-chat-clear') }).strict(),
  z.object({ type: z.literal('remote-reveal') }).strict(),
  z.object({ type: z.literal('remote-stop') }).strict(),
]);
export type RemoteRequest = z.infer<typeof remoteRequestSchema>;

// Relay -> extension frames.
export const relayFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), ts: z.number().optional() }),
  z.object({
    type: z.literal('req'),
    id: z.number().int(),
    method: z.string().max(128),
    params: z.record(z.unknown()).default({}),
    requestId: z.string().max(128).optional(),
    deadline: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('chat'),
    role: z.enum(['assistant', 'system']).default('assistant'),
    text: z.string().max(MAX_CHAT_TEXT),
    final: z.boolean().default(true),
    ts: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('chat-status'),
    state: z.string(),
    chatId: z.string().max(128).optional(),
    code: z.string().optional(),
    error: z.string().optional(),
    ts: z.number().optional(),
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
