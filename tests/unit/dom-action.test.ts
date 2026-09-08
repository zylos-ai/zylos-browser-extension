import { afterEach, expect, test, vi } from 'vitest';
import source from '../../utils/automation/injected/dom-action.js?raw';

const action = (0, eval)(`(${source})`) as (
  this: HTMLElement,
  action: string,
  option?: boolean,
) => unknown;
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test('input preparation scrolls minimally and focus never causes a second viewport jump', () => {
  const input = document.createElement('input');
  document.body.append(input);
  const scroll = vi.fn();
  input.scrollIntoView = scroll;
  const focus = vi.spyOn(input, 'focus');
  action.call(input, 'prepare-input', true);
  expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(document.activeElement).toBe(input);
});
test('visible button preparation avoids forced centering and still rejects an obstruction', () => {
  const button = document.createElement('button');
  document.body.append(button);
  button.scrollIntoView = vi.fn();
  button.getBoundingClientRect = () => ({ x: 10, y: 20, width: 100, height: 40 }) as DOMRect;
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => button });
  expect(action.call(button, 'point', true)).toEqual({ x: 60, y: 40 });
  expect(button.scrollIntoView).toHaveBeenCalledWith({
    block: 'nearest',
    inline: 'nearest',
    behavior: 'instant',
  });
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => document.body,
  });
  expect(() => action.call(button, 'point', false)).toThrow('covered');
});
