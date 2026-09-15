import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  browserLanguage,
  LANGUAGE_STORAGE_KEY,
  languagePreference,
  localizeError,
  resolveLocale,
  translate,
  type LanguagePreference,
  type TranslationKey,
} from '../utils/i18n';

function useLanguageState() {
  const [preference, setPreference] = useState<LanguagePreference>('auto');
  const [browser, setBrowser] = useState(browserLanguage);
  const [ready, setReady] = useState(false);
  const [savingLanguage, setSavingLanguage] = useState(false);
  const [languageError, setLanguageError] = useState(false);
  const locale = resolveLocale(preference, browser);
  useEffect(() => {
    let active = true;
    let changed = false;
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[LANGUAGE_STORAGE_KEY]) {
        changed = true;
        setPreference(languagePreference(changes[LANGUAGE_STORAGE_KEY].newValue));
      }
    };
    const onLanguage = () => setBrowser(browserLanguage());
    chrome.storage.onChanged.addListener(onStorage);
    window.addEventListener('languagechange', onLanguage);
    void chrome.storage.local
      .get([LANGUAGE_STORAGE_KEY])
      .then((saved) => {
        if (active && !changed) setPreference(languagePreference(saved[LANGUAGE_STORAGE_KEY]));
      })
      .catch(() => {})
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(onStorage);
      window.removeEventListener('languagechange', onLanguage);
    };
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  async function changeLanguage(next: LanguagePreference) {
    if (savingLanguage) return;
    setSavingLanguage(true);
    setLanguageError(false);
    try {
      await chrome.storage.local.set({ [LANGUAGE_STORAGE_KEY]: next });
      setPreference(next);
    } catch {
      setLanguageError(true);
    } finally {
      setSavingLanguage(false);
    }
  }
  return {
    locale,
    preference,
    changeLanguage,
    savingLanguage,
    languageError,
    ready,
    t: (key: TranslationKey, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    errorText: (message: string) => localizeError(locale, message),
  };
}
const LanguageContext = createContext<ReturnType<typeof useLanguageState> | null>(null);
export function LanguageProvider({ children }: { children: ReactNode }) {
  const value = useLanguageState();
  return (
    <LanguageContext.Provider value={value}>
      {value.ready ? children : null}
    </LanguageContext.Provider>
  );
}
export function useI18n() {
  const value = useContext(LanguageContext);
  if (!value) throw new Error('LanguageProvider is required');
  return value;
}
