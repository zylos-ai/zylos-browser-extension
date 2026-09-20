// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { commandSchema } from '../../utils/commands';
import {
  describeTools,
  parameterSchema,
  browserParams,
  BROWSER_METHODS,
  toolHelp,
} from '../../utils/tool-catalog';

describe('extension-owned Agent reference', () => {
  it('covers every local action schema', () => {
    expect(Object.keys(toolHelp).sort()).toEqual([...BROWSER_METHODS].sort());
    const catalog = describeTools(BROWSER_METHODS);
    expect(catalog.tools.map((tool) => tool.name)).toEqual(BROWSER_METHODS);
    for (const method of BROWSER_METHODS)
      expect(() => parameterSchema(browserParams[method])).not.toThrow();
  });

  it('exports actual required fields, defaults, enums, array bounds and nested targets', () => {
    const detail = describeTools(['fill', 'scroll', 'drag']);
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
    expect(byName.scroll?.constraints?.join(' ')).toContain('never combine ref');
    expect(commandSchema.safeParse({ op: 'click', ref: 'r', x: 1, y: 2 }).success).toBe(false);
    expect(commandSchema.safeParse({ op: 'keypress', key: 'unsupported-key' }).success).toBe(false);
  });

  it('validates every documented example with the same execution schemas', () => {
    for (const name of BROWSER_METHODS) {
      const help = toolHelp[name] as { examples?: Record<string, unknown>[] };
      for (const example of help.examples || []) {
        expect(browserParams[name].safeParse(example).success, name).toBe(true);
        if (!['use-current-tab', 'read-page', 'finalize'].includes(name))
          expect(commandSchema.safeParse({ op: name, ...example }).success, name).toBe(true);
      }
    }
    expect(() => parameterSchema(z.date())).toThrow('No parameter exporter');
  });
});
