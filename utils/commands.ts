// Wire protocol v1. This client-owned validator must remain compatible with tests/fixtures/commands.v1.cases.json.
import { z } from 'zod';

export const commandSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('pause') }).strict(),
  z
    .object({
      op: z.literal('finalize'),
      taskId: z.string().uuid(),
      keep: z.array(z.number().int().nonnegative()).max(8).default([]),
    })
    .strict(),
  z.object({ op: z.literal('finish') }).strict(),
  z.object({ op: z.literal('observe'), interactive: z.boolean().default(false) }).strict(),
  z.object({ op: z.literal('snapshot'), interactive: z.boolean().default(false) }).strict(),
  z.object({ op: z.literal('click'), ref: z.string().max(100) }).strict(),
  z
    .object({ op: z.literal('fill'), ref: z.string().max(100), text: z.string().max(20000) })
    .strict(),
  z
    .object({ op: z.literal('type'), ref: z.string().max(100), text: z.string().max(20000) })
    .strict(),
  z
    .object({
      op: z.literal('scroll'),
      direction: z.enum(['up', 'down', 'left', 'right']),
      pixels: z.number().int().min(1).max(2000).default(500),
    })
    .strict(),
  z
    .object({
      op: z.literal('keypress'),
      key: z.enum([
        'Enter',
        'Tab',
        'Escape',
        'Backspace',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
      ]),
    })
    .strict(),
  z.object({ op: z.literal('open'), url: z.string().url().max(4000) }).strict(),
  z.object({ op: z.literal('new-tab'), url: z.string().url().max(4000) }).strict(),
  z.object({ op: z.literal('switch-tab'), tabId: z.number().int().nonnegative() }).strict(),
  z.object({ op: z.literal('screenshot') }).strict(),
  z.object({ op: z.literal('tabs') }).strict(),
  z.object({ op: z.literal('stop') }).strict(),
]);
export type Command = z.infer<typeof commandSchema>;
