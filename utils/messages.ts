import { z } from 'zod';

export const tabSchema = z.object({
  id: z.number().int(),
  windowId: z.number().int().optional(),
  url: z.string(),
  title: z.string(),
});
export const controlSchema = z
  .object({
    scope: z.literal('task'),
    windowId: z.number().int(),
    sessionId: z.string(),
    groupId: z.number().int().nonnegative(),
    tabId: z.number().int().nonnegative(),
    tabIds: z.array(z.number().int().nonnegative()).min(1).max(8),
  })
  .refine(
    (control) =>
      control.tabIds.includes(control.tabId) &&
      new Set(control.tabIds).size === control.tabIds.length,
    'Invalid task-tab membership',
  );
export const chatSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  at: z.string(),
});
export const authorizationSchema = z.object({
  id: z.string().uuid(),
  requestContext: z.string().uuid(),
  tool: z.string().max(80),
  goal: z.string().max(12000),
  expiresAt: z.number().finite(),
  status: z.enum([
    'pending',
    'approving',
    'approved',
    'denied',
    'expired',
    'cancelled',
    'resume-failed',
  ]),
});
export type AuthorizationState = z.infer<typeof authorizationSchema>;
export const stateSchema = z.object({
  ready: z.boolean(),
  connecting: z.boolean(),
  connectionError: z.string(),
  hasSavedConnection: z.boolean(),
  status: z.string(),
  deviceId: z.string().optional(),
  url: z.string(),
  tab: tabSchema.nullable(),
  control: controlSchema.nullable(),
  history: z.array(chatSchema),
  authorization: authorizationSchema.nullable().default(null),
});
export type PanelState = z.infer<typeof stateSchema>;
export type TabState = z.infer<typeof tabSchema>;
export type ControlState = z.infer<typeof controlSchema>;
export type ChatEntry = z.infer<typeof chatSchema>;

export const requestSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('approve-authorization'),
      id: z.string().uuid(),
      windowId: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ type: z.literal('deny-authorization'), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('get-state') }).strict(),
  z
    .object({ type: z.literal('pair'), url: z.string().max(4000), code: z.string().max(100) })
    .strict(),
  z.object({ type: z.literal('reconnect') }).strict(),
  z
    .object({
      type: z.literal('grant'),
      scope: z.enum(['task', 'window']),
      mode: z.enum(['new', 'current']).optional(),
      windowId: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ type: z.literal('stop') }).strict(),
  z.object({ type: z.literal('reveal-task') }).strict(),
  z.object({ type: z.literal('disconnect') }).strict(),
  z.object({ type: z.literal('chat'), text: z.string().trim().min(1).max(12000) }).strict(),
]);
export type PanelRequest = z.infer<typeof requestSchema>;
export const responseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: stateSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export const stateEventSchema = z.object({ type: z.literal('ui-state'), state: stateSchema });
export const initialState: PanelState = {
  ready: false,
  connecting: false,
  connectionError: '',
  hasSavedConnection: false,
  status: '正在读取连接状态…',
  url: 'http://127.0.0.1:3460',
  tab: null,
  control: null,
  history: [],
  authorization: null,
};

export function isPanelSender(sender: chrome.runtime.MessageSender): boolean {
  // Exact bundled entrypoints only. No content scripts, websites, guessed paths or queries.
  return (
    sender.id === chrome.runtime.id &&
    ['popup.html', 'sidepanel.html'].some((path) => sender.url === chrome.runtime.getURL(path))
  );
}
