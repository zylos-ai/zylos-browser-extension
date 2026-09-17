import { expect, test, vi } from 'vitest';
import { PageActions, type ElementRef } from '../../utils/automation/page-actions';

test('a full ref with or without @ resolves the same live node; shortened and stale refs remain invalid', async () => {
  const frame = { id: 'main', url: 'https://example.com/', sessionId: undefined };
  const refs = new Map<string, ElementRef>([
    ['@1a2b3c4d-e17', { backendNodeId: 17, generation: 2, frame }],
    ['@1a2b3c4d-e18', { backendNodeId: 18, generation: 1, frame }],
  ]);
  const send = vi.fn(async (method: string) =>
    method === 'DOM.resolveNode'
      ? { object: { objectId: 'node-17' } }
      : { result: { value: true } },
  );
  const actions = new PageActions({
    send,
    refs,
    generation: 2,
    mouse: vi.fn(),
    preview: vi.fn(),
    check: vi.fn(),
    dragData: vi.fn(),
  });
  vi.spyOn(actions, 'safeFrames').mockResolvedValue([frame]);
  for (const ref of ['@1a2b3c4d-e17', '1a2b3c4d-e17']) {
    expect(await actions.resolve(ref)).toMatchObject({ objectId: 'node-17' });
  }
  for (const ref of ['e17', '1a2b3c4d-e18', '@1a2b3c4d-e18', '1a2b3c4d-e99', '@@1a2b3c4d-e17']) {
    await expect(actions.resolve(ref)).rejects.toMatchObject({ code: 'STALE_ELEMENT' });
  }
  expect(send.mock.calls.filter(([method]) => method === 'DOM.resolveNode')).toHaveLength(2);
});
