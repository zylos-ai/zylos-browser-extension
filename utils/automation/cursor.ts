import source from './injected/cursor.js?raw';
export const cursorExpression = (update: unknown): string =>
  `${source}\nrenderCursor(${JSON.stringify(update)});`;
