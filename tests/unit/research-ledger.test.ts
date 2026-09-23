// @vitest-environment node
import { expect, it } from 'vitest';
import { ResearchLedger } from '../../utils/research-ledger';
const item = (key: string, position?: number) => ({
  key,
  title: key,
  summary: 'Observed revenue and downloads',
  sourceUrl: 'https://example.com/chart',
  position,
});

it('deduplicates overlapping screens and counts rank coverage including gaps', () => {
  const ledger = new ResearchLedger();
  ledger.record({ collection: 'chart', targetCount: 3, items: [item('a', 1), item('b', 3)] });
  ledger.record({
    collection: 'chart',
    items: [item('b', 3), item('duplicate-rank', 3), item('out-of-range', 4)],
  });
  expect(ledger.summary().collections[0]).toMatchObject({ collected: 4, covered: 2, remaining: 1 });
  expect(ledger.incomplete).toBe(true);
  ledger.record({ collection: 'chart', items: [item('c', 2)] });
  expect(ledger.incomplete).toBe(false);
  expect(ledger.read({ collection: 'chart', limit: 2 })).toMatchObject({ total: 5, nextOffset: 2 });
  expect(ledger.read({ offset: 4 }).nextOffset).toBeNull();
  expect(new ResearchLedger().active).toBe(false);
});
it('rejects target changes and capacity overflow atomically, retaining earlier entries', () => {
  const ledger = new ResearchLedger();
  ledger.record({ collection: 'chart', targetCount: 200, items: [item('a')] });
  expect(() => ledger.record({ collection: 'chart', targetCount: 1, items: [] })).toThrow(
    'cannot change',
  );
  for (let i = 0; i < 9; i++) ledger.record({ collection: String(i), items: [] });
  expect(() => ledger.record({ collection: 'overflow', items: [item('lost')] })).toThrow(
    'storage is full',
  );
  expect(ledger.read({}).total).toBe(1);
});
it('bounds UTF-8 storage, not only JavaScript character count', () => {
  const ledger = new ResearchLedger();
  const batch = (start: number) =>
    Array.from({ length: 30 }, (_, i) => ({
      ...item(String(start + i)),
      summary: '字'.repeat(1000),
    }));
  ledger.record({ collection: 'chart', items: batch(0) });
  expect(() => ledger.record({ collection: 'chart', items: batch(30) })).toThrow('storage is full');
  expect(ledger.read({ limit: 20 }).items.length).toBeLessThan(20);
  expect(ledger.read({}).total).toBe(30);
});
