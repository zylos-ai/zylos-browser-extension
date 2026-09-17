import { isBlockedUrl } from '../guard';

export function canReadPage(tab: chrome.tabs.Tab) {
  try {
    const url = new URL(tab.url || '');
    return (
      tab.id !== undefined &&
      !tab.incognito &&
      !tab.pendingUrl &&
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !['chromewebstore.google.com', 'chrome.google.com'].includes(url.hostname) &&
      !isBlockedUrl(url.href)
    );
  } catch {
    return false;
  }
}

type AXNode = {
  nodeId: string;
  childIds?: string[];
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: unknown;
  properties?: { name: string; value?: { value?: unknown } }[];
};

/** A small text excerpt, without live refs or editable field values. */
export function excerptFromAX(nodes: AXNode[], limit = 6000) {
  const hidden = new Set<string>();
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const inputRoles = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
  for (const node of nodes) {
    if (
      !node.value &&
      !inputRoles.has(node.role?.value || '') &&
      !node.properties?.some((p) => ['protected', 'editable'].includes(p.name) && p.value?.value)
    )
      continue;
    const pending = [node.nodeId];
    while (pending.length) {
      const id = pending.pop()!;
      if (hidden.has(id)) continue;
      hidden.add(id);
      pending.push(...(byId.get(id)?.childIds || []));
    }
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  let length = 0;
  let truncated = false;
  for (const node of nodes) {
    const role = node.role?.value || '';
    const name = node.name?.value?.trim();
    if (node.ignored || hidden.has(node.nodeId) || !name || role === 'InlineTextBox') continue;
    const line = `${role}: ${name}`;
    if (seen.has(line)) continue;
    seen.add(line);
    if (length + line.length + 1 > limit) {
      const remaining = limit - length - 1;
      if (remaining > 0) lines.push(line.slice(0, remaining));
      truncated = true;
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  return { text: lines.join('\n'), truncated };
}

type Frame = { id: string; loaderId?: string; url?: string };
export async function readPageExcerpt(tab: chrome.tabs.Tab & { id: number }, reuse: boolean) {
  let attached = false;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const target = { tabId: tab.id };
  const detach = async () => {
    if (!attached) return;
    attached = false;
    await chrome.debugger.detach(target).catch(() => {});
  };
  const check = () => {
    if (expired) throw new Error('CONTEXT_TIMEOUT');
  };
  const read = async () => {
    if (!reuse) {
      await chrome.debugger.attach(target, '1.3');
      attached = true;
      if (expired) {
        await detach();
        check();
      }
    }
    const frame = async () => {
      check();
      const result = (await chrome.debugger.sendCommand(target, 'Page.getFrameTree')) as {
        frameTree: { frame: Frame };
      };
      check();
      return result.frameTree.frame;
    };
    const before = await frame();
    if (before.url !== tab.url) throw new Error('PAGE_CHANGED');
    const result = (await chrome.debugger.sendCommand(target, 'Accessibility.getFullAXTree', {
      frameId: before.id,
    })) as { nodes: AXNode[] };
    check();
    const after = await frame();
    const fresh = await chrome.tabs.get(tab.id);
    check();
    if (
      !canReadPage(fresh) ||
      fresh.windowId !== tab.windowId ||
      fresh.url !== tab.url ||
      after.loaderId !== before.loaderId ||
      after.url !== before.url
    )
      throw new Error('PAGE_CHANGED');
    return { ...excerptFromAX(result.nodes || []), loaderId: before.loaderId };
  };
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error('CONTEXT_TIMEOUT'));
        }, 2500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    expired = true;
    // Also handles a late attach after the timeout, inside read().
    await detach();
  }
}
