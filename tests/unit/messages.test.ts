import { afterEach, expect, test, vi } from 'vitest';
import {
  isPanelSender,
  requestSchema,
  responseSchema,
  initialState,
  controlSchema,
} from '../../utils/messages';
import { normalizeEndpoint } from '../../entrypoints/background/endpoint';
afterEach(() => vi.unstubAllGlobals());
test('task control requires an explicitly registered target and unique bounded work tabs', () => {
  const control = {
    scope: 'task',
    windowId: 1,
    sessionId: 'test',
    groupId: 7,
    tabId: 2,
    tabIds: [2],
  };
  expect(controlSchema.safeParse(control).success).toBe(true);
  for (const tabIds of [[], [3], [2, 2], [1, 2, 3, 4, 5, 6, 7, 8, 9]])
    expect(controlSchema.safeParse({ ...control, tabIds }).success).toBe(false);
  expect(
    requestSchema.safeParse({ type: 'grant', scope: 'task', mode: 'new', tabId: 99 }).success,
  ).toBe(false);
});
test('only exact extension UI pages can send privileged messages', () => {
  const id = 'a'.repeat(32);
  vi.stubGlobal('chrome', {
    runtime: { id, getURL: (path: string) => 'chrome-extension://' + id + '/' + path },
  });
  for (const path of ['popup.html', 'sidepanel.html'])
    expect(isPanelSender({ id, url: chrome.runtime.getURL(path) })).toBe(true);
  for (const url of [
    'https://example.com',
    chrome.runtime.getURL('popup.html?x=1'),
    chrome.runtime.getURL('other.html'),
    chrome.runtime.getURL('panel.html'),
  ])
    expect(isPanelSender({ id, url })).toBe(false);
  expect(isPanelSender({ id: 'other', url: chrome.runtime.getURL('popup.html') })).toBe(false);
});
test('request validation rejects implicit consent, unknown commands and token-bearing UI responses strip secrets', () => {
  expect(requestSchema.safeParse({ type: 'grant' }).success).toBe(false);
  expect(requestSchema.safeParse({ type: 'eval', source: 'alert(1)' }).success).toBe(false);
  expect(requestSchema.safeParse({ type: 'chat', text: '  ' }).success).toBe(false);
  const safe = responseSchema.parse({
    ok: true,
    value: { ...initialState, token: 'should-not-reach-ui' },
  });
  expect(JSON.stringify(safe)).not.toContain('should-not-reach-ui');
});
test('endpoint permits secure remote and loopback only, never URL credentials or query secrets', () => {
  expect(normalizeEndpoint('https://agent.example.com')).toBe(
    'wss://agent.example.com/browser-control/ws',
  );
  expect(normalizeEndpoint('ws://127.0.0.1:3460/browser-control/ws')).toBe(
    'ws://127.0.0.1:3460/browser-control/ws',
  );
  for (const url of [
    'http://agent.example.com',
    'https://user:secret@agent.example.com',
    'https://agent.example.com?token=x',
    'https://agent.example.com#x',
  ])
    expect(() => normalizeEndpoint(url)).toThrow();
});
