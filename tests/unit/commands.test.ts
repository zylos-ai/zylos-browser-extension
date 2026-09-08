import { expect, test } from 'vitest';
import { commandSchema } from '../../utils/commands';
import cases from '../fixtures/commands.v1.cases.json';
test('browser command validator conforms to the local version 1 wire contract', () => {
  expect(cases.protocol).toBe(1);
  for (const item of cases.valid) expect(commandSchema.parse(item.input)).toEqual(item.expected);
  for (const input of cases.invalid) expect(commandSchema.safeParse(input).success).toBe(false);
});
