import { z } from 'zod';

// This channel is extension-local. Frames must never enter RemoteState, storage or RPC.
export const PREVIEW_PORT = 'live-page-preview';
export const previewStateSchema = z.object({
  targetKey: z.string(),
  sessionId: z.string(),
  tabId: z.number().int(),
  windowId: z.number().int(),
  title: z.string(),
  url: z.string(),
  status: z.enum(['running', 'paused', 'completed', 'stopped', 'interrupted', 'error']),
  availability: z.enum(['connecting', 'live', 'paused', 'unavailable']),
  canReveal: z.boolean(),
  canStop: z.boolean(),
});
export type PreviewState = z.infer<typeof previewStateSchema>;
export const previewFrameSchema = z.object({
  targetKey: z.string(),
  sequence: z.number().int(),
  capturedAt: z.number(),
  dataUrl: z
    .string()
    .max(500_000)
    .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/),
});
export type PreviewFrame = z.infer<typeof previewFrameSchema>;
export const previewMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('preview-state'), preview: previewStateSchema.nullable() }),
  z.object({ type: z.literal('preview-frame'), frame: previewFrameSchema }),
]);
