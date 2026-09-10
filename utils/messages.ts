export function isPanelSender(sender: chrome.runtime.MessageSender): boolean {
  // Exact bundled entrypoints only. No content scripts, websites, guessed paths or queries.
  return (
    sender.id === chrome.runtime.id &&
    ['popup.html', 'sidepanel.html'].some((path) => sender.url === chrome.runtime.getURL(path))
  );
}
