// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { commandSchema } from '../../utils/commands';
import {
  describeTools,
  parameterSchema,
  remoteParams,
  REMOTE_METHODS,
  toolHelp,
} from '../../utils/tool-catalog';

describe('extension-owned Agent reference', () => {
  it('covers every executable RPC schema and keeps discovery concise', () => {
    expect(Object.keys(toolHelp).sort()).toEqual([...REMOTE_METHODS].sort());
    const catalog = describeTools();
    expect(catalog.tools.map((tool) => tool.name)).toEqual(REMOTE_METHODS);
    expect(catalog.instructions).toContain('Browser operation guide');
    expect(catalog.instructions).toContain('SENSITIVE_INPUT');
    expect(Buffer.byteLength(JSON.stringify(catalog))).toBeLessThan(16000);
    for (const tool of catalog.tools) expect(tool).not.toHaveProperty('parameters');
    for (const method of REMOTE_METHODS)
      expect(() => parameterSchema(remoteParams[method])).not.toThrow();
  });

  it('exports actual required fields, defaults, enums, array bounds and nested targets', () => {
    const detail = describeTools(['fill', 'scroll', 'drag', 'wait', 'describe']);
    const byName = Object.fromEntries(detail.tools.map((tool) => [tool.name, tool]));
    expect(byName.fill?.parameters).toMatchObject({
      required: ['ref', 'text'],
      additionalProperties: false,
      properties: { text: { type: 'string', maxLength: 20000 }, ref: { minLength: 1 } },
    });
    expect(byName.scroll?.parameters).toMatchObject({
      required: ['direction'],
      properties: {
        direction: { enum: ['up', 'down', 'left', 'right'] },
        pixels: { type: 'integer', minimum: 1, maximum: 2000, default: 500 },
      },
    });
    expect(byName.drag?.parameters).toMatchObject({
      properties: {
        from: { type: 'object' },
        steps: { default: 12 },
        modifiers: { type: 'array', maxItems: 4 },
      },
    });
    expect(byName.wait?.parameters).toMatchObject({
      properties: { timeoutMs: { default: 10000, maximum: 60000 } },
    });
    expect(byName.describe?.parameters).toMatchObject({
      properties: { methods: { minItems: 1, maxItems: 8 } },
    });
    expect(byName.scroll?.constraints?.join(' ')).toContain('never combine ref');
    expect(commandSchema.safeParse({ op: 'click', ref: 'r', x: 1, y: 2 }).success).toBe(false);
    expect(commandSchema.safeParse({ op: 'keypress', key: 'unsupported-key' }).success).toBe(false);
  });

  it('validates every documented example with the same execution schemas', () => {
    for (const name of REMOTE_METHODS) {
      const help = toolHelp[name] as { examples?: Record<string, unknown>[] };
      for (const example of help.examples || []) {
        expect(remoteParams[name].safeParse(example).success, name).toBe(true);
        if (!['describe', 'info', 'start', 'finalize', 'step'].includes(name))
          expect(commandSchema.safeParse({ op: name, ...example }).success, name).toBe(true);
      }
    }
    expect(() => parameterSchema(z.date())).toThrow('No parameter exporter');
  });

  it('exports executable nested action/read alternatives for the composite tool', () => {
    const schema = describeTools(['step']).tools[0]!.parameters as any;
    expect(schema.required).toEqual(['action', 'read']);
    const actions = schema.properties.action.oneOf;
    expect(actions.find((s: any) => s.properties.op.const === 'fill')).toMatchObject({
      required: ['ref', 'text', 'op'],
    });
    expect(actions.some((s: any) => s.properties.op.const === 'step')).toBe(false);
    const navigation = schema.properties.wait.oneOf.find(
      (s: any) => s.properties.condition.const === 'navigation',
    );
    expect(Object.keys(navigation.properties)).toEqual(['condition', 'timeoutMs']);
    expect(navigation.additionalProperties).toBe(false);
    expect(schema.properties.read.oneOf.map((s: any) => s.properties.op.const)).toEqual([
      'snapshot',
      'observe',
      'find',
      'inspect',
    ]);
  });
});
