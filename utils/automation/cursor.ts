import source from './injected/cursor.js?raw';
import palette from '../../assets/brand/palette.css?raw';
import { translate, workerLocale } from '../i18n';

export const cursorExpression = (update: unknown): string => {
  const locale = workerLocale();
  const labels = {
    move: translate(locale, 'cursorMove'),
    click: translate(locale, 'cursorClick'),
    input: translate(locale, 'cursorInput'),
    scroll: translate(locale, 'cursorScroll'),
    key: translate(locale, 'cursorKey'),
    working: translate(locale, 'cursorWorking'),
  };
  return `${source}\nrenderCursor(${JSON.stringify(update)}, ${JSON.stringify(palette)}, ${JSON.stringify(labels)});`;
};
