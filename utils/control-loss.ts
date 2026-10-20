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
    recoveryOutcome: z.enum(['expired', 'failed', 'revoked']).optional(),
  })
  .strict();
export type ControlInterruption = z.infer<typeof interruptionSchema>;
export type RecoveryOutcome = NonNullable<ControlInterruption['recoveryOutcome']>;
export const CONTROL_RECOVERY_WINDOW_MS = 120_000;
export const CONTROL_RECOVERY_ATTEMPT_MS = 10_000;
export const CONTROL_RECOVERY_CAPABILITY = 'recovery-judgment-v1';
export type ControlRecovery = {
  recoveryId: string;
  expiresAt: number;
  reason: 'target_closed';
  cause: 'unknown';
};
export class ControlSuspended extends Error {
  readonly code = 'CONTROL_SUSPENDED';
  constructor(
    readonly recovery: ControlRecovery,
    readonly results: ControlInterruption['results'],
  ) {
    super('Browser control is suspended; an explicit recovery decision is required');
  }
}
export class ControlLoss extends Error {
  readonly code = 'STOPPED';
  constructor(readonly interruption: ControlInterruption) {
    super('Browser control was lost; a new user message is required');
  }
}
