// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { FOCUSED_ELEMENT } from '../../utils/automation/frames';

const evaluate = () => (0, eval)(FOCUSED_ELEMENT) as Element | null;

test('resolves a frame owner focused inside an open shadow root', () => {
  document.body.innerHTML = '<div id="host"></div><input id="plain">';
  const root = document.querySelector('#host')!.attachShadow({ mode: 'open' });
  root.innerHTML = '<iframe id="inner"></iframe>';
  const frame = root.querySelector('iframe')!;
  frame.tabIndex = 0;
  frame.focus();
  expect(evaluate()).toBe(frame);
});

test.each(['object', 'embed'])('returns a focused <%s> so its frame can be followed', (tag) => {
  document.body.innerHTML = `<${tag} id="owner" tabindex="0"></${tag}>`;
  const owner = document.querySelector<HTMLElement>('#owner')!;
  owner.focus();
  expect(evaluate()).toBe(owner);
});

test('returns a plain focused input unchanged', () => {
  document.body.innerHTML = '<input id="plain">';
  const input = document.querySelector('input')!;
  input.focus();
  expect(evaluate()).toBe(input);
});
