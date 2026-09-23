import { z } from 'zod';

const finding = z
  .object({
    key: z.string().trim().min(1).max(160),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(1000),
    sourceUrl: z
      .string()
      .url()
      .max(4000)
      .refine((v) => /^https?:\/\//.test(v), 'Use an observed HTTP(S) source URL'),
    position: z.number().int().min(1).max(10000).optional(),
  })
  .strict();
export const researchParams = {
  'record-findings': z
    .object({
      collection: z.string().trim().min(1).max(100),
      targetCount: z.number().int().min(1).max(10000).optional(),
      items: z.array(finding).max(50),
    })
    .strict(),
  'read-findings': z
    .object({
      collection: z.string().trim().min(1).max(100).optional(),
      offset: z.number().int().min(0).max(500).default(0),
      limit: z.number().int().min(1).max(20).default(10),
    })
    .strict(),
};
type Finding = z.infer<typeof finding> & { collection: string };
type Collection = { targetCount?: number; items: Map<string, Finding> };
const fail = (message: string): never => {
  throw Object.assign(new Error(message), { code: 'FINDINGS_LIMIT' });
};

// Task-local, bounded, source-linked model notes. Never treat model notes as
// independently verified facts, or counting notes as proof of dataset coverage.
export class ResearchLedger {
  private collections = new Map<string, Collection>();
  record(value: unknown) {
    const data = researchParams['record-findings'].parse(value);
    const previous = this.collections.get(data.collection);
    if (
      previous?.targetCount !== undefined &&
      data.targetCount !== undefined &&
      previous.targetCount !== data.targetCount
    )
      fail(
        'The declared coverage target cannot change during this task. Report partial results with blocked if it cannot be reached.',
      );
    const updated: Collection = {
      targetCount: previous?.targetCount ?? data.targetCount,
      items: new Map(previous?.items),
    };
    for (const item of data.items)
      updated.items.set(item.key, { ...item, collection: data.collection });
    const next = new Map(this.collections).set(data.collection, updated);
    const all = [...next.values()].flatMap((c) => [...c.items.values()]);
    if (
      next.size > 10 ||
      all.length > 500 ||
      new TextEncoder().encode(JSON.stringify(all)).length > 160000
    )
      fail(
        'Task findings storage is full (10 collections, 500 items, 160 KB). Existing findings were retained; summarize what is available.',
      );
    this.collections = next;
    return { recorded: data.items.length, ...this.summary() };
  }
  summary() {
    return {
      evidence: 'agent-recorded',
      collections: [...this.collections].map(([name, c]) => {
        const positions = new Set(
          [...c.items.values()].flatMap((i) => (i.position === undefined ? [] : [i.position])),
        );
        // For ranked scans, duplicates and gaps cannot be hidden by the raw item count.
        const covered =
          positions.size && c.targetCount !== undefined
            ? [...positions].filter((p) => p <= c.targetCount!).length
            : c.items.size;
        return {
          name,
          collected: c.items.size,
          covered,
          targetCount: c.targetCount,
          remaining: c.targetCount === undefined ? undefined : Math.max(0, c.targetCount - covered),
        };
      }),
    };
  }
  get incomplete() {
    return this.summary().collections.some((c) => (c.remaining ?? 0) > 0);
  }
  get active() {
    return this.collections.size > 0;
  }
  read(value: unknown) {
    const { collection, offset, limit } = researchParams['read-findings'].parse(value);
    const items = [...this.collections]
      .filter(([name]) => !collection || name === collection)
      .flatMap(([, c]) => [...c.items.values()]);
    // Paginate by bytes as well as count: never send the entire research ledger each turn.
    const page: Finding[] = [];
    let bytes = 0;
    for (const item of items.slice(offset, offset + limit)) {
      const size = new TextEncoder().encode(JSON.stringify(item)).length;
      if (page.length && bytes + size > 12000) break;
      page.push(item);
      bytes += size;
    }
    const next = offset + page.length;
    return {
      items: page,
      total: items.length,
      nextOffset: next < items.length ? next : null,
      ...this.summary(),
    };
  }
}
