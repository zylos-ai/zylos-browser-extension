import { afterEach, expect, test, vi } from 'vitest';
import { PageActions } from '../../utils/automation/page-actions';
import source from '../../utils/automation/injected/dom-action.js?raw';

const domAction = (0, eval)(`(${source})`);
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function setup(preview: (input: HTMLInputElement) => void = () => {}) {
  const input = document.createElement('input');
  input.value = 'old';
  input.scrollIntoView = vi.fn();
  document.body.append(input);
  const frame = { id: 'main', url: 'https://example.test/' };
  const send = vi.fn(async (method: string, params: any) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'original' } };
    if (method === 'Runtime.callFunctionOn') {
      try {
        return {
          result: {
            value: domAction.call(input, params.arguments[0].value, params.arguments[1].value),
          },
        };
      } catch (error) {
        return { exceptionDetails: { exception: { description: String(error) } } };
      }
    }
    if (method === 'Input.insertText') {
      input.setRangeText(params.text, input.selectionStart!, input.selectionEnd!, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return {};
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const actions = new PageActions({
    send,
    refs: new Map([['@12345678-e1', { backendNodeId: 1, generation: 1, frame }]]),
    generation: 1,
    mouse: vi.fn(),
    preview: vi.fn(async () => preview(input)),
    check: vi.fn(),
    dragData: vi.fn(),
  });
  vi.spyOn(actions, 'safeFrames').mockResolvedValue([frame]);
  return {
    input,
    actions,
    send,
    inserts: () => send.mock.calls.filter(([method]) => method === 'Input.insertText'),
  };
}

test('fill replaces the value even when preview collapses the selection, with one input event', async () => {
  const { input, actions, inserts } = setup((input) => input.setSelectionRange(3, 3));
  const event = vi.fn();
  input.addEventListener('input', event);
  await actions.run({ op: 'fill', ref: '@12345678-e1', text: 'new' });
  expect(input.value).toBe('new');
  expect(inserts()).toHaveLength(1);
  expect(event).toHaveBeenCalledTimes(1);
});
test('type preserves the existing caret instead of selecting the whole field', async () => {
  const { input, actions, inserts } = setup((input) => input.setSelectionRange(1, 1));
  await actions.run({ op: 'type', ref: '@12345678-e1', text: 'X' });
  expect(input.value).toBe('oXld');
  expect(inserts()).toHaveLength(1);
});
test('fill does not select text until the preview has completed', async () => {
  const { input, actions } = setup((input) => {
    expect(input.selectionStart).toBe(3);
    expect(input.selectionEnd).toBe(3);
  });
  input.setSelectionRange(3, 3);
  await actions.run({ op: 'fill', ref: '@12345678-e1', text: 'new' });
  expect(input.value).toBe('new');
});
test('state changes caused synchronously by selection are checked again before native input', async () => {
  const { input, actions, inserts } = setup();
  vi.spyOn(input, 'select').mockImplementation(() => {
    input.type = 'password';
  });
  await expect(actions.run({ op: 'fill', ref: '@12345678-e1', text: 'new' })).rejects.toMatchObject(
    { code: 'SENSITIVE_INPUT' },
  );
  expect(inserts()).toHaveLength(0);
});
test.each(['readonly', 'disabled', 'password', 'otp', 'file', 'replace', 'focus'])(
  'refuses %s changes during preview without inserting or reacquiring focus',
  async (change) => {
    let replacement: HTMLInputElement | undefined;
    const { input, actions, inserts } = setup((input) => {
      if (change === 'readonly') input.readOnly = true;
      if (change === 'disabled') input.disabled = true;
      if (change === 'password' || change === 'file') input.type = change;
      if (change === 'otp') input.autocomplete = 'one-time-code';
      if (change === 'replace' || change === 'focus') {
        replacement = document.createElement('input');
        replacement.value = 'untouched';
        if (change === 'replace') input.replaceWith(replacement);
        else document.body.append(replacement);
        replacement.focus();
      }
    });
    await expect(actions.run({ op: 'fill', ref: '@12345678-e1', text: 'new' })).rejects.toThrow();
    expect(inserts()).toHaveLength(0);
    if (replacement) {
      expect(replacement.value).toBe('untouched');
      expect(document.activeElement).toBe(replacement);
    } else if (change !== 'file') expect(input.value).toBe('old');
  },
);
test('a failed native insertion is propagated without retry', async () => {
  const { actions, send, inserts } = setup();
  const original = send.getMockImplementation()!;
  const error = new Error('Detached while handling command');
  send.mockImplementation(async (method, params) => {
    if (method === 'Input.insertText') throw error;
    return original(method, params);
  });
  await expect(actions.run({ op: 'fill', ref: '@12345678-e1', text: 'new' })).rejects.toBe(error);
  expect(inserts()).toHaveLength(1);
});
test('native detach while resolving the original node is preserved, not labeled stale', async () => {
  const { actions, send, inserts } = setup();
  const error = new Error('Detached while handling command.');
  send.mockRejectedValueOnce(error);
  await expect(actions.run({ op: 'fill', ref: '@12345678-e1', text: 'new' })).rejects.toBe(error);
  expect(inserts()).toHaveLength(0);
});
test('a specifically missing original node is labeled stale without searching for a replacement', async () => {
  const { actions, send, inserts } = setup();
  send.mockRejectedValueOnce(new Error('No node with given id found'));
  await expect(actions.run({ op: 'fill', ref: '@12345678-e1', text: 'new' })).rejects.toMatchObject(
    { code: 'STALE_ELEMENT' },
  );
  expect(send).toHaveBeenCalledTimes(1);
  expect(inserts()).toHaveLength(0);
});
test('focus handlers that disable the original node fail before preview', async () => {
  const { input, actions, inserts } = setup();
  input.addEventListener('focus', () => {
    input.readOnly = true;
  });
  await expect(actions.run({ op: 'fill', ref: '@12345678-e1', text: 'new' })).rejects.toThrow(
    'not editable',
  );
  expect(inserts()).toHaveLength(0);
});
