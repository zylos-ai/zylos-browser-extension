import { z } from 'zod';
import { diagnosticMethod } from './diagnostics-schema';

export const interruptionSchema = z
  .object({
    reason: z.literal('CONTROL_LOST'),
    results: z
      .array(
        z
          .object({
            method: diagnosticMethod,
            outcome: z.enum(['completed', 'uncertain', 'not-executed']),
          })
          .strict(),
      )
      .max(10),
    observation: z.literal('unavailable'),
    resume: z.literal('new-user-message-required'),
  })
  .strict();
export type ControlInterruption = z.infer<typeof interruptionSchema>;
export class ControlLoss extends Error {
  readonly code = 'STOPPED';
  constructor(readonly interruption: ControlInterruption) {
    super('Browser control was lost; a new user message is required');
  }
}
