import { z } from 'zod';

const ref = z.string().min(1).max(100);
const coordinate = z.number().finite().min(0).max(100000);
const modifiers = z
  .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
  .max(4)
  .optional();
const target = { ref: ref.optional(), x: coordinate.optional(), y: coordinate.optional() };
const selector = z.string().min(1).max(2000);
const frameId = z.string().min(1).max(200).optional();
const text = z.string().max(20000);

// Shared by local commands and Remote. The relay only transports these objects.
export const actionParams = {
  pause: z.object({}).strict(),
  finish: z.object({}).strict(),
  stop: z.object({}).strict(),
  tabs: z.object({}).strict(),
  frames: z.object({}).strict(),
  snapshot: z
    .object({ interactive: z.boolean().default(false), viewport: z.boolean().default(true) })
    .strict(),
  observe: z.object({ interactive: z.boolean().default(false) }).strict(),
  'wait-for-page': z
    .object({ timeoutMs: z.number().int().min(1000).max(8000).default(5000), ...target })
    .strict(),
  screenshot: z.object({}).strict(),
  click: z.object({ ...target, modifiers }).strict(),
  hover: z.object(target).strict(),
  'double-click': z.object({ ...target, modifiers }).strict(),
  'right-click': z.object({ ...target, modifiers }).strict(),
  drag: z
    .object({
      from: z.object(target).strict(),
      to: z.object(target).strict(),
      steps: z.number().int().min(2).max(60).default(12),
      modifiers,
    })
    .strict(),
  fill: z.object({ ref, text }).strict(),
  type: z.object({ ref, text }).strict(),
  select: z.object({ ref, values: z.array(z.string().max(1000)).min(1).max(100) }).strict(),
  check: z.object({ ref, checked: z.boolean() }).strict(),
  inspect: z.object({ ref }).strict(),
  find: z.object({ selector, frameId }).strict(),
  scroll: z
    .object({
      direction: z.enum(['up', 'down', 'left', 'right']),
      pixels: z.number().int().min(1).max(2000).default(500),
      ...target,
    })
    .strict(),
  keypress: z
    .object({
      key: z
        .string()
        .refine(
          (v) =>
            [...v].length === 1 ||
            [
              'Enter',
              'Tab',
              'Escape',
              'Backspace',
              'Delete',
              'ArrowUp',
              'ArrowDown',
              'ArrowLeft',
              'ArrowRight',
              'Home',
              'End',
              'PageUp',
              'PageDown',
              'Space',
            ].includes(v),
          'Unsupported key',
        ),
      modifiers,
      ref: ref.optional(),
    })
    .strict(),
  open: z.object({ url: z.string().url().max(4000) }).strict(),
  'new-tab': z.object({ url: z.string().url().max(4000) }).strict(),
  'switch-tab': z.object({ tabId: z.number().int().nonnegative() }).strict(),
  back: z.object({}).strict(),
  forward: z.object({}).strict(),
  reload: z.object({}).strict(),
  dialog: z
    .object({
      action: z.enum(['get', 'accept', 'dismiss']).default('get'),
      promptText: z.string().max(8000).optional(),
    })
    .strict(),
  wait: z
    .object({
      condition: z.enum([
        'attached',
        'detached',
        'visible',
        'hidden',
        'enabled',
        'clickable',
        'checked',
        'text',
        'url',
        'loaded',
        'new-tab',
      ]),
      ref: ref.optional(),
      selector: selector.optional(),
      frameId,
      text: z.string().min(1).max(4000).optional(),
      url: z.string().min(1).max(4000).optional(),
      checked: z.boolean().optional(),
      timeoutMs: z.number().int().min(1).max(60000).default(10000),
    })
    .strict(),
};

export const commandSchema = z
  .discriminatedUnion('op', [
    actionParams.pause.extend({ op: z.literal('pause') }),
    z
      .object({
        op: z.literal('finalize'),
        taskId: z.string().uuid(),
        keep: z.array(z.number().int().nonnegative()).max(8).default([]),
      })
      .strict(),
    actionParams.finish.extend({ op: z.literal('finish') }),
    actionParams.stop.extend({ op: z.literal('stop') }),
    actionParams.tabs.extend({ op: z.literal('tabs') }),
    actionParams.frames.extend({ op: z.literal('frames') }),
    actionParams.snapshot.extend({ op: z.literal('snapshot') }),
    actionParams.observe.extend({ op: z.literal('observe') }),
    actionParams['wait-for-page'].extend({ op: z.literal('wait-for-page') }),
    actionParams.screenshot.extend({ op: z.literal('screenshot') }),
    actionParams.click.extend({ op: z.literal('click') }),
    actionParams.hover.extend({ op: z.literal('hover') }),
    actionParams['double-click'].extend({ op: z.literal('double-click') }),
    actionParams['right-click'].extend({ op: z.literal('right-click') }),
    actionParams.drag.extend({ op: z.literal('drag') }),
    actionParams.fill.extend({ op: z.literal('fill') }),
    actionParams.type.extend({ op: z.literal('type') }),
    actionParams.select.extend({ op: z.literal('select') }),
    actionParams.check.extend({ op: z.literal('check') }),
    actionParams.inspect.extend({ op: z.literal('inspect') }),
    actionParams.find.extend({ op: z.literal('find') }),
    actionParams.scroll.extend({ op: z.literal('scroll') }),
    actionParams.keypress.extend({ op: z.literal('keypress') }),
    actionParams.open.extend({ op: z.literal('open') }),
    actionParams['new-tab'].extend({ op: z.literal('new-tab') }),
    actionParams['switch-tab'].extend({ op: z.literal('switch-tab') }),
    actionParams.back.extend({ op: z.literal('back') }),
    actionParams.forward.extend({ op: z.literal('forward') }),
    actionParams.reload.extend({ op: z.literal('reload') }),
    actionParams.dialog.extend({ op: z.literal('dialog') }),
    actionParams.wait.extend({ op: z.literal('wait') }),
  ])
  .superRefine((command, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const validateTarget = (p: { ref?: string; x?: number; y?: number }, optional = false) => {
      const hasRef = p.ref !== undefined,
        hasPoint = p.x !== undefined || p.y !== undefined;
      if (hasRef && hasPoint) issue('Use either ref or x/y');
      if (hasPoint && (p.x === undefined || p.y === undefined)) issue('Both x and y are required');
      if (!optional && !hasRef && !hasPoint) issue('A ref or x/y point is required');
    };
    if (
      ['click', 'hover', 'double-click', 'right-click', 'scroll', 'wait-for-page'].includes(
        command.op,
      )
    )
      validateTarget(
        command as { ref?: string; x?: number; y?: number },
        ['scroll', 'wait-for-page'].includes(command.op),
      );
    if (command.op === 'drag') {
      validateTarget(command.from);
      validateTarget(command.to);
    }
    if (command.op === 'wait') {
      if (command.ref && command.selector) issue('Use either ref or selector');
      if (
        ['attached', 'detached', 'visible', 'hidden', 'enabled', 'clickable', 'checked'].includes(
          command.condition,
        ) &&
        !command.ref &&
        !command.selector
      )
        issue('This condition requires ref or selector');
      if (command.condition === 'text' && !command.text) issue('text is required');
      if (command.condition === 'url' && !command.url) issue('url is required');
    }
  });
export type Command = z.infer<typeof commandSchema>;
