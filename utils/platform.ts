import { z } from 'zod';

// The development build is explicit; never infer trust from a webpage-supplied URL.
export const platformApi = 'http://127.0.0.1:18089/api/v1/browser';
export const platformWeb = 'http://localhost:3000/workspace';
export const deviceAuthMessage = '浏览器连接已失效，请重新连接 OpenMAX。';
export class PlatformApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}
export const platformTaskSchema = z.object({
  id: z.string().uuid(),
  endpoint_id: z.union([z.string().uuid(), z.literal('')]),
  connection_epoch: z.union([z.string().uuid(), z.literal('')]),
  owner_identity_id: z.string().uuid(),
  source_id: z.string().default(''),
  state: z.enum([
    'awaiting_consent',
    'preparing',
    'running',
    'waiting_user',
    'finalizing',
    'closed',
  ]),
  revision: z.string().regex(/^[0-9]+$/),
  activation_id: z.string().uuid(),
  control_session_id: z.string(),
  deadline: z.string(),
  absolute_deadline: z.string(),
  outcome: z.string(),
  cleanup_state: z.string(),
});
export type PlatformTask = z.infer<typeof platformTaskSchema>;

export function browserOperationError(error: unknown) {
  return {
    // The Channel uses NO_CONTROLLABLE_TAB to navigate a fresh about:blank tab.
    // Erasing this code would prevent open from taking that safe fallback.
    code: error instanceof Error && 'code' in error ? String(error.code) : 'BROWSER_ERROR',
    message: error instanceof Error ? error.message : 'Browser operation failed',
  };
}

// Older polling responses must not undo a newer approval or cleanup.
export function newerPlatformTask(
  current: PlatformTask | null,
  incoming: PlatformTask | null,
): PlatformTask | null {
  if (
    current &&
    incoming?.id === current.id &&
    BigInt(incoming.revision) < BigInt(current.revision)
  )
    return current;
  if (
    current &&
    current.state !== 'closed' &&
    (!incoming || (incoming.id !== current.id && incoming.state === 'closed'))
  )
    return current;
  return incoming;
}
export const platformUserSchema = z.object({
  identity_id: z.string().uuid(),
  display_name: z.string(),
});
export const platformStateSchema = z.object({
  connected: z.boolean(),
  authRequired: z.boolean().default(false),
  busy: z.boolean(),
  error: z.string(),
  user: platformUserSchema.nullable(),
  task: platformTaskSchema.nullable(),
  hasWorkTab: z.boolean().default(false),
  loginPending: z.boolean(),
});
export type PlatformState = z.infer<typeof platformStateSchema>;
export const platformRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('platform-state') }).strict(),
  z.object({ type: z.literal('platform-login') }).strict(),
  z.object({ type: z.literal('platform-disconnect') }).strict(),
  z.object({ type: z.literal('platform-reveal') }).strict(),
  z
    .object({
      type: z.literal('platform-decide'),
      action: z.literal('stop'),
      taskId: z.string().uuid(),
    })
    .strict(),
]);
export const initialPlatformState: PlatformState = {
  connected: false,
  authRequired: false,
  busy: false,
  error: '',
  user: null,
  task: null,
  hasWorkTab: false,
  loginPending: false,
};
export const bindingConfirmationSchema = z
  .object({
    type: z.literal('browser-user-login-confirm'),
    code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export const deviceProbeSchema = z
  .object({
    type: z.literal('browser-device-probe'),
    taskId: z.string().uuid(),
    revision: z.string().regex(/^[0-9]+$/),
  })
  .strict();
export const deviceProofSchema = z.object({
  browser_proof: z.string().min(32).max(4096),
  endpoint_id: z.string().uuid(),
  connection_epoch: z.string().uuid(),
  expires_at: z.string().datetime({ offset: true }),
});
function platformPageSenderAllowed(
  sender: chrome.runtime.MessageSender,
  currentTab: chrome.tabs.Tab | undefined,
  pathname: string,
): boolean {
  if (
    sender.frameId !== 0 ||
    sender.tab?.id === undefined ||
    sender.tab.incognito ||
    !sender.url ||
    !currentTab?.url ||
    currentTab.id !== sender.tab.id ||
    currentTab.incognito
  )
    return false;
  try {
    // Chrome can retain the document's initial sender.url after SPA navigation.
    // Trust the original sender's origin, but validate the route using a fresh
    // chrome.tabs.get result. Never accept a current URL supplied by the webpage.
    const origin = new URL(platformWeb).origin;
    const current = new URL(currentTab.url);
    return (
      new URL(sender.url).origin === origin &&
      (sender.origin === undefined || sender.origin === origin) &&
      current.origin === origin &&
      current.pathname === pathname
    );
  } catch {
    return false;
  }
}
export function chatActionSenderAllowed(
  sender: chrome.runtime.MessageSender,
  currentTab: chrome.tabs.Tab | undefined,
): boolean {
  return platformPageSenderAllowed(sender, currentTab, '/workspace');
}
export function bindingCallbackAllowed(
  sender: chrome.runtime.MessageSender,
  nonce: string,
  candidate: unknown,
  currentTab: chrome.tabs.Tab | undefined,
): boolean {
  return (
    !!nonce &&
    candidate === nonce &&
    platformPageSenderAllowed(sender, currentTab, '/workspace/account')
  );
}
