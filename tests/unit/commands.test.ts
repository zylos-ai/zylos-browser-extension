import { expect, test } from 'vitest';
import { commandSchema } from '../../utils/commands';
import cases from '../fixtures/commands.cases.json';
test('browser commands validate parameters and apply their defaults', () => {
  for (const item of cases.valid) expect(commandSchema.parse(item.input)).toEqual(item.expected);
  for (const input of cases.invalid) expect(commandSchema.safeParse(input).success).toBe(false);
});
