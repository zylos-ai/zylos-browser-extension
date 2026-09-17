import { z } from 'zod';
import { actionParams, commandSchema } from './commands';

// Exactly one action, an optional explicit condition, and one observation.
// Never accepts nested steps, arbitrary scripts, cleanup, or a second mutation.
export const stepParams = z
  .object({
    action: z.discriminatedUnion('op', [
      actionParams.open.extend({ op: z.literal('open') }),
      actionParams['new-tab'].extend({ op: z.literal('new-tab') }),
      actionParams['switch-tab'].extend({ op: z.literal('switch-tab') }),
      z.object({ op: z.literal('use-current-tab'), contextId: z.string().uuid() }).strict(),
      actionParams.click.extend({ op: z.literal('click') }),
      actionParams.hover.extend({ op: z.literal('hover') }),
      actionParams.fill.extend({ op: z.literal('fill') }),
      actionParams.type.extend({ op: z.literal('type') }),
      actionParams.select.extend({ op: z.literal('select') }),
      actionParams.check.extend({ op: z.literal('check') }),
      actionParams.scroll.extend({ op: z.literal('scroll') }),
      actionParams.keypress.extend({ op: z.literal('keypress') }),
      actionParams.back.extend({ op: z.literal('back') }),
      actionParams.forward.extend({ op: z.literal('forward') }),
      actionParams.reload.extend({ op: z.literal('reload') }),
    ]),
    wait: z
      .discriminatedUnion('condition', [
        actionParams.wait,
        z
          .object({
            condition: z.literal('navigation'),
            timeoutMs: actionParams.wait.shape.timeoutMs,
          })
          .strict(),
      ])
      .optional(),
    read: z.discriminatedUnion('op', [
      actionParams.snapshot.extend({ op: z.literal('snapshot') }),
      actionParams.observe.extend({ op: z.literal('observe') }),
      actionParams.find.extend({ op: z.literal('find') }),
      actionParams.inspect.extend({ op: z.literal('inspect') }),
    ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [key, command] of [
      ['action', value.action],
      ['wait', value.wait && { op: 'wait', ...value.wait }],
      ['read', value.read],
    ] as const) {
      if (!command || command.op === 'use-current-tab') continue;
      if (command.op === 'wait' && command.condition === 'navigation') continue;
      const parsed = commandSchema.safeParse(command);
      if (!parsed.success)
        for (const issue of parsed.error.issues)
          ctx.addIssue({ ...issue, path: [key, ...issue.path] });
    }
    if (value.wait?.condition === 'new-tab')
      ctx.addIssue({
        code: 'custom',
        path: ['wait'],
        message: 'Handle popups separately: wait for the new tab, select it, then observe.',
      });
    if (value.wait?.condition === 'navigation' && !['click', 'keypress'].includes(value.action.op))
      ctx.addIssue({
        code: 'custom',
        path: ['wait'],
        message:
          'navigation waits belong to click/keypress steps on the current tab. Use loaded for open/back/forward/reload.',
      });
    if (value.wait?.condition === 'loaded' && !navigationActions.has(value.action.op))
      ctx.addIssue({
        code: 'custom',
        path: ['wait'],
        message:
          'For clicks/keypresses that navigate, use navigation without a URL; otherwise wait for an observed element state. loaded may already be true on the old page.',
      });
  });

export const navigationActions = new Set(['open', 'new-tab', 'back', 'forward', 'reload']);
export type ActionStep = z.infer<typeof stepParams>;
export type StepPart = {
  stage: 'action' | 'wait' | 'read';
  method: string;
  status: 'success' | 'error' | 'skipped';
  durationMs?: number;
  result?: unknown;
  error?: { code: string; message: string };
};
export type StepResult = { completed: boolean; steps: StepPart[] };
// Keep mutation receipts, not up to 200 full DOM snapshots or image payloads.
// A replay never reruns an action and never pretends its observation is fresh.
export function stepReceipt(result: StepResult): StepResult {
  return {
    ...result,
    steps: result.steps.map((part) =>
      part.stage === 'read' && part.result !== undefined
        ? { ...part, result: { omittedFromReplay: true } }
        : part,
    ),
  };
}
export type StepObserver = (
  method: string,
  params: Record<string, unknown>,
) => { finish(errorCode?: string): void } | undefined;
