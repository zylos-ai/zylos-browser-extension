import { afterEach, expect, it, vi } from 'vitest';
import {
  captureIncidentPageState,
  incidentPageStateProbe,
  pinIncidentDocument,
} from '../../utils/automation/incident-page-state';

const expected = { tabId: 12, windowId: 1, url: 'https://example.test/', documentId: 'doc-1' };
const state = {
  visibility: 'visible',
  readyState: 'complete',
  scheme: 'https',
  iframeCount: 0,
  iframeCountCapped: false,
  focusedElement: 'none',
  inputFocused: false,
  inputDisabled: false,
  inputReadOnly: false,
};
const setup = () => {
  const executeScript = vi.fn(async (_options: unknown) => [
    { frameId: 0, documentId: 'doc-1', result: { observedAt: 123, state } },
  ]);
  vi.stubGlobal('chrome', {
    tabs: { get: vi.fn(async () => ({ id: 12, windowId: 1, url: expected.url })) },
    webNavigation: { getFrame: vi.fn(async () => ({ documentId: 'doc-1', url: expected.url })) },
    scripting: { executeScript },
  });
  return executeScript;
};
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('pins permitted documents and captures only the allowed fields in the isolated world', async () => {
  const execute = setup();
  execute.mockResolvedValueOnce([
    {
      frameId: 0,
      documentId: 'doc-1',
      result: {
        observedAt: 123,
        state: { ...state, url: 'PRIVATE', value: 'PRIVATE' } as any,
      },
    },
  ]);
  expect(await pinIncidentDocument(12, () => true)).toEqual(expected);
  expect(await captureIncidentPageState(expected, () => true)).toEqual({
    status: 'captured',
    observedAt: 123,
    state,
  });
  expect(execute.mock.calls[0]?.[0]).toMatchObject({
    target: { tabId: 12, documentIds: ['doc-1'] },
    world: 'ISOLATED',
  });
});

it('refuses denied reads and rejects replacement documents', async () => {
  const execute = setup();
  vi.mocked(chrome.tabs.get).mockResolvedValueOnce({
    id: 12,
    url: 'chrome://settings/',
    windowId: 1,
  } as any);
  expect(await pinIncidentDocument(12, () => true)).toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
  execute.mockResolvedValueOnce([
    { frameId: 0, documentId: 'doc-2', result: { observedAt: 123, state } },
  ]);
  expect((await captureIncidentPageState(expected, () => true)).status).toBe('stale');
});

it('drops late results when the task changes and does not leak errors', async () => {
  const execute = setup();
  let current = true;
  execute.mockImplementationOnce(async () => {
    current = false;
    return [{ frameId: 0, documentId: 'doc-1', result: { observedAt: 123, state } }];
  });
  expect((await captureIncidentPageState(expected, () => current)).status).toBe('stale');
  execute.mockRejectedValueOnce(new Error('PRIVATE'));
  const result = await captureIncidentPageState(expected, () => true);
  expect(result.status).toBe('unavailable');
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});

it('bounds pending operations and prevents injection after timeout', async () => {
  vi.useFakeTimers();
  const execute = setup();
  let resolveTab!: (value: any) => void;
  vi.mocked(chrome.tabs.get).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveTab = resolve;
      }) as any,
  );
  const result = captureIncidentPageState(expected, () => true);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await result).status).toBe('unavailable');
  resolveTab({ id: 12, windowId: 1, url: expected.url });
  await vi.advanceTimersByTimeAsync(0);
  expect(execute).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('reads focus category without input values or text and reports bounded iframe counts', () => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const input = document.createElement('input');
  input.value = 'PRIVATE_VALUE';
  input.readOnly = true;
  document.body.append(input);
  input.focus();
  for (let i = 0; i < 520; i++)
    document.body.append(document.createElementNS('urn:test', 'iframe'));
  const result = incidentPageStateProbe();
  expect(result.state).toMatchObject({
    focusedElement: 'input',
    inputFocused: true,
    inputReadOnly: true,
    iframeCountCapped: true,
  });
  expect(result.state!.iframeCount).toBeLessThanOrEqual(512);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
