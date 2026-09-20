import { useEffect, useState } from 'react';
import { canReadPage } from '../utils/page-reader';
import { useI18n } from './LanguageProvider';

export function CurrentPage() {
  const { t } = useI18n();
  const [page, setPage] = useState<chrome.tabs.Tab | null>(null);
  useEffect(() => {
    let active = true;
    let version = 0;
    const refresh = async () => {
      const request = ++version;
      try {
        const win = await chrome.windows.getCurrent();
        const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
        if (active && request === version) setPage(tab && canReadPage(tab) ? tab : null);
      } catch {
        if (active && request === version) setPage(null);
      }
    };
    const updated = () => {
      void refresh();
    };
    chrome.tabs.onActivated.addListener(updated);
    chrome.tabs.onUpdated.addListener(updated);
    void refresh();
    return () => {
      active = false;
      chrome.tabs.onActivated.removeListener(updated);
      chrome.tabs.onUpdated.removeListener(updated);
    };
  }, []);
  return (
    <div className="current-page" title={page ? `${page.url}\n${t('currentPageHint')}` : undefined}>
      <span className="current-page-label">{t('currentPage')}</span>
      <span className="current-page-title">
        {page ? page.title || page.url : t('currentPageUnavailable')}
      </span>
      {page && <span className="current-page-hint">{t('currentPageHint')}</span>}
    </div>
  );
}
