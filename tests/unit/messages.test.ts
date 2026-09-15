import { expect, test, vi } from 'vitest';
import { isPanelSender } from '../../utils/messages';
test('只有本插件打包的 UI 可以调用内部接口', () => {
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'a'.repeat(32),
      getURL: (p: string) => 'chrome-extension://' + 'a'.repeat(32) + '/' + p,
    },
  });
  const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('sidepanel.html') };
  expect(isPanelSender(sender)).toBe(true);
  for (const url of [
    'https://evil.test',
    chrome.runtime.getURL('popup.html'),
    chrome.runtime.getURL('sidepanel.html?grant=1'),
    chrome.runtime.getURL('other.html'),
  ])
    expect(isPanelSender({ ...sender, url })).toBe(false);
  expect(isPanelSender({ ...sender, id: 'b'.repeat(32) })).toBe(false);
  vi.unstubAllGlobals();
});
