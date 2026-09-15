import zh from '../locales/zh-CN';
import en from '../locales/en';

export type Locale = 'zh-CN' | 'en';
export type LanguagePreference = Locale | 'auto';
export type TranslationKey = keyof typeof zh;
export const LANGUAGE_STORAGE_KEY = 'uiLanguage';
export const messages = { 'zh-CN': zh, en };

export function languagePreference(value: unknown): LanguagePreference {
  return value === 'zh-CN' || value === 'en' ? value : 'auto';
}
export function browserLanguage(): string {
  return globalThis.chrome?.i18n?.getUILanguage() || globalThis.navigator?.language || 'en';
}
export function resolveLocale(preference: LanguagePreference, browser = browserLanguage()): Locale {
  return preference === 'auto' ? (/^zh(?:-|_|$)/i.test(browser) ? 'zh-CN' : 'en') : preference;
}
export function translate(
  locale: Locale,
  key: TranslationKey,
  params: Record<string, string | number> = {},
): string {
  return messages[locale][key].replace(/\{(\w+)\}/g, (match, name: string) =>
    String(params[name] ?? match),
  );
}
/** Only extension-owned error codes are translated. Relay diagnostics and chat are untouched. */
export function localizeError(locale: Locale, message: string): string {
  return message
    .split(/; |；|\n/)
    .map((part) => {
      const key = part.startsWith('ui.error.') ? part.slice(9) : '';
      return Object.hasOwn(messages[locale], key) ? translate(locale, key as TranslationKey) : part;
    })
    .join(locale === 'en' ? '; ' : '；');
}
export function formatMessageDate(ts: number, locale: Locale, now = Date.now()): string {
  const date = new Date(ts);
  if (date.toDateString() === new Date(now).toDateString()) return translate(locale, 'today');
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
}

// The worker reads the same saved preference for the cursor and tab-group label.
let workerPreference: LanguagePreference = 'auto';
export function setWorkerLanguage(value: unknown) {
  workerPreference = languagePreference(value);
}
export function workerLocale(): Locale {
  return resolveLocale(workerPreference);
}
