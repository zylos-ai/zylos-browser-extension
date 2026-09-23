import { expect, test } from 'vitest';
import {
  formatMessageDate,
  languagePreference,
  localizeError,
  panelErrorMessage,
  messages,
  resolveLocale,
  translate,
} from '../../utils/i18n';

test('browser language chooses Chinese variants or English, while an explicit choice wins', () => {
  for (const language of ['zh-CN', 'zh-TW', 'zh-HK', 'zh'])
    expect(resolveLocale('auto', language)).toBe('zh-CN');
  for (const language of ['en-US', 'en-GB', 'ja', 'fr', ''])
    expect(resolveLocale('auto', language)).toBe('en');
  expect(resolveLocale('en', 'zh-CN')).toBe('en');
  expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN');
  expect(languagePreference('unsupported')).toBe('auto');
});

test('known panel failures translate by code without rewriting external diagnostics', () => {
  for (const code of [
    'CLEANUP_PENDING',
    'DEBUGGER_DETACH_FAILED',
    'CONTROL_NOT_GRANTED',
    'TASK_TAB_UNAVAILABLE',
    'STALE_TASK',
    'STOPPED',
  ]) {
    const message = panelErrorMessage(Object.assign(new Error('Raw diagnostic'), { code }));
    expect(message).toMatch(/^ui\.error\./);
    expect(localizeError('en', message)).not.toMatch(/ui\.error|\p{Script=Han}/u);
    expect(localizeError('zh-CN', message)).toMatch(/\p{Script=Han}/u);
  }
  const custom = Object.assign(new Error('Agent 自定义错误'), { code: 'CUSTOM_ERROR' });
  expect(panelErrorMessage(custom)).toBe(custom.message);
});

test('both dictionaries have the same keys and interpolation placeholders', () => {
  expect(Object.keys(messages.en).sort()).toEqual(Object.keys(messages['zh-CN']).sort());
  for (const key of Object.keys(messages.en) as (keyof typeof messages.en)[]) {
    expect(messages.en[key].match(/\{\w+\}/g)).toEqual(messages['zh-CN'][key].match(/\{\w+\}/g));
  }
  expect(translate('en', 'taskTab', { count: 1 })).toBe('1 work tab · View anytime');
  expect(translate('en', 'taskTabs', { count: 2 })).toBe('2 work tabs · View anytime');
});

test('dates and extension errors are localized; external diagnostics are preserved', () => {
  const today = new Date(2026, 8, 15, 12).getTime();
  expect(formatMessageDate(today, 'en', today)).toBe('Today');
  expect(formatMessageDate(today, 'zh-CN', today)).toBe('今天');
  expect(formatMessageDate(new Date(2026, 8, 14, 12).getTime(), 'en', today)).toBe(
    'September 14, 2026',
  );
  expect(localizeError('en', 'ui.error.invalidKey')).toBe(messages.en.invalidKey);
  expect(localizeError('en', 'ui.error.invalidRelayUrl；ui.error.invalidKey')).toBe(
    `${messages.en.invalidRelayUrl}; ${messages.en.invalidKey}`,
  );
  expect(localizeError('en', 'Agent 自定义错误')).toBe('Agent 自定义错误');
});
