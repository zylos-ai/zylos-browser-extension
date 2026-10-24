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

test.each(['fill', 'type'] as const)(
  'a private %s commit validates focus without repeating preparation',
  async (op) => {
    const frame = { id: 'main', url: 'https://example.com/' };
    const calls: string[] = [];
    const send = vi.fn(async (method: string, params?: Record<string, any>) => {
      calls.push(method === 'Runtime.callFunctionOn' ? params!.arguments[0].value : method);
      return { result: { value: null } };
    });
    const preview = vi.fn();
    const actions = new PageActions({
      send,
      refs: new Map(),
      generation: 1,
      mouse: vi.fn(),
      preview,
      check: vi.fn(),
      dragData: vi.fn(),
      beforeInput: () => {
        calls.push('consume');
      },
    });
    vi.spyOn(actions, 'resolve').mockResolvedValue({ objectId: 'fresh-node', frame });
    expect(await actions.commitInput({ op, ref: '@1a2b3c4d-e1', text: 'fixture' })).toEqual({
      done: true,
    });
    expect(calls).toEqual(['commit-input', 'consume', 'Input.insertText']);
    expect(send.mock.calls[0]![1]!.arguments[1].value).toBe(op === 'fill');
    expect(preview).not.toHaveBeenCalled();
  },
);

test.each(['focus-changed', 'revoked', 'native-rejected'])(
  'private commit does not retry after %s',
  async (failure) => {
    let inserts = 0;
    const send = vi.fn(async (method: string) => {
      if (method === 'Runtime.callFunctionOn' && failure === 'focus-changed')
        return { exceptionDetails: { text: 'Focus changed during input preview' } };
      if (method === 'Input.insertText') {
        inserts++;
        throw new Error('Detached while handling command');
      }
      return { result: { value: null } };
    });
    const actions = new PageActions({
      send,
      refs: new Map(),
      generation: 1,
      mouse: vi.fn(),
      preview: vi.fn(),
      check: vi.fn(),
      dragData: vi.fn(),
      beforeInput: () => {
        if (failure === 'revoked') throw new Error('STOPPED');
      },
    });
    vi.spyOn(actions, 'resolve').mockResolvedValue({
      objectId: 'fresh-node',
      frame: { id: 'main' },
    });
    await expect(
      actions.commitInput({ op: 'fill', ref: '@1a2b3c4d-e1', text: 'fixture' }),
    ).rejects.toThrow();
    expect(inserts).toBe(failure === 'native-rejected' ? 1 : 0);
    expect(send.mock.calls.filter(([method]) => method === 'Runtime.callFunctionOn')).toHaveLength(
      1,
    );
  },
);

test.each(['ready', 'focus-detached', 'value-changed'])(
  'type preparation checkpoints %s without inserting',
  async (mode) => {
    const frame = { id: 'main', url: 'https://example.com/' };
    let reads = 0;
    const onInputPrepared = vi.fn();
    const send = vi.fn(async (_method: string, params?: Record<string, any>) => {
      const action = params!.arguments[0].value;
      if (action === 'read-input-state') {
        reads++;
        return {
          result: {
            value: {
              value: mode === 'value-changed' && reads === 2 ? 'changed' : 'original',
              start: reads === 1 ? 0 : 8,
              end: reads === 1 ? 0 : 8,
            },
          },
        };
      }
      if (action === 'prepare-input' && mode === 'focus-detached') throw new Error('detached');
      return { result: { value: { x: 1, y: 1 } } };
    });
    const actions = new PageActions({
      send,
      refs: new Map(),
      generation: 1,
      mouse: vi.fn(),
      preview: vi.fn(),
      check: vi.fn(),
      dragData: vi.fn(),
      onInputPrepared,
    });
    vi.spyOn(actions, 'resolve').mockResolvedValue({ objectId: 'node', frame });
    vi.spyOn(actions, 'safeFrames').mockResolvedValue([frame]);
    const preparation = actions.prepareInput({ op: 'type', ref: '@1a2b3c4d-e1', text: 'fixture' });
    if (mode === 'ready') await expect(preparation).resolves.toMatchObject({ objectId: 'node' });
    else await expect(preparation).rejects.toThrow();
    expect(onInputPrepared.mock.calls[0]).toEqual([{ value: 'original', start: 0, end: 0 }, false]);
    expect(onInputPrepared).toHaveBeenCalledTimes(mode === 'ready' ? 2 : 1);
    if (mode === 'ready')
      expect(onInputPrepared.mock.calls[1]).toEqual([
        { value: 'original', start: 8, end: 8 },
        true,
      ]);
    expect(send.mock.calls.every(([method]) => method === 'Runtime.callFunctionOn')).toBe(true);
  },
);
