import { useEffect, useRef, useState } from 'react';
import { canReadPage } from '../utils/page-reader';
import {
  readPageSelection,
  pageSelectionSchema,
  selectionKey,
  type PageSelection,
} from '../utils/page-selection';

/** Small DOM-only reads while the panel is visible; no debugger or Agent calls. */
export function usePageSelection(enabled: boolean) {
  const [selection, setSelection] = useState<PageSelection | null>(null);
  const [faviconUrl, setFaviconUrl] = useState<string>();
  const current = useRef<PageSelection | null>(null);
  const ignored = useRef<string | null>(null);

  const clearSelection = (expected = current.current) => {
    if (!expected || !current.current || selectionKey(expected) !== selectionKey(current.current))
      return;
    ignored.current = selectionKey(expected);
    current.current = null;
    setSelection(null);
  };

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let reading = false;
    let revision = 0;
    let selectedTab: number | undefined;
    let pageKey = '';
    let documentId = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => document.visibilityState !== 'hidden';
    const reset = () => {
      current.current = null;
      ignored.current = null;
      documentId = '';
      setSelection(null);
      setFaviconUrl(undefined);
    };
    const refresh = async () => {
      clearTimeout(timer);
      if (disposed || reading || !visible()) return;
      reading = true;
      const version = revision;
      const valid = () => !disposed && revision === version;
      try {
        const win = await chrome.windows.getCurrent();
        const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
        if (!valid()) return;
        const usable = tab && canReadPage(tab) ? tab : null;
        const key = usable ? `${usable.id}:${usable.url}` : '';
        selectedTab = tab?.id;
        if (key !== pageKey) {
          pageKey = key;
          reset();
        }
        if (!usable) return;
        const [read] = await readPageSelection(usable.id!);
        if (
          !valid() ||
          !read?.documentId ||
          !read.result ||
          read.frameId !== 0 ||
          read.result.url !== usable.url
        )
          return;
        if (documentId && documentId !== read.documentId) reset();
        documentId = read.documentId;
        if (!read.result.text) {
          // The chip follows the page's actual selection, not a sticky quotation.
          current.current = null;
          setSelection(null);
          ignored.current = null;
          return;
        }
        const parsed = pageSelectionSchema.safeParse({
          ...read.result,
          tabId: usable.id,
          documentId,
          title: (usable.title || '').slice(0, 300),
        });
        if (!parsed.success) return;
        // Display metadata only; the icon is not part of the Agent message.
        setFaviconUrl(usable.favIconUrl);
        const next = parsed.data;
        const fingerprint = selectionKey(next);
        if (
          ignored.current === fingerprint ||
          (current.current && selectionKey(current.current) === fingerprint)
        )
          return;
        ignored.current = null;
        current.current = next;
        setSelection(next);
      } catch {
        // Restricted pages and temporary access failures do not interrupt chat.
      } finally {
        reading = false;
        if (!disposed && visible()) timer = setTimeout(() => void refresh(), 600);
      }
    };
    const invalidate = () => {
      revision++;
      pageKey = '';
      reset();
      void refresh();
    };
    const activated = (info: { tabId: number; windowId: number }) => {
      // A different Chrome window must not clear this panel's attachment.
      void chrome.windows
        .getCurrent()
        .then((win) => {
          if (!disposed && info.windowId === win.id) invalidate();
        })
        .catch(() => {});
    };
    const updated = (tabId: number, change: chrome.tabs.OnUpdatedInfo) => {
      if (tabId === selectedTab && (change.url || change.status === 'loading')) invalidate();
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.visibilityState !== 'hidden') void refresh();
    };
    chrome.tabs.onActivated.addListener(activated);
    chrome.tabs.onUpdated.addListener(updated);
    document.addEventListener('visibilitychange', visibility);
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
      chrome.tabs.onActivated.removeListener(activated);
      chrome.tabs.onUpdated.removeListener(updated);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [enabled]);
  return { selection, faviconUrl, clearSelection };
}
