import { afterEach, expect, test, vi } from 'vitest';
import source from '../../utils/automation/injected/dom-action.js?raw';

const action = (0, eval)(`(${source})`) as (
  this: HTMLElement,
  action: string,
  option?: unknown,
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

test.each(['value', 'caret', 'focus'] as const)(
  'checkpoint commit rejects changed %s before selection',
  (change) => {
    const input = document.createElement('input');
    const other = document.createElement('input');
    document.body.append(input, other);
    input.value = 'original';
    input.setSelectionRange(2, 2);
    const expected = action.call(input, 'read-input-state');
    input.focus();
    if (change === 'value') input.value = 'owner changed';
    if (change === 'caret') input.setSelectionRange(3, 3);
    if (change === 'focus') other.focus();
    const select = vi.spyOn(input, 'select');
    const focus = vi.spyOn(input, 'focus');
    expect(() =>
      action.call(input, 'commit-input', { replace: change !== 'caret', expected }),
    ).toThrow();
    expect(select).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  },
);

test.each([true, false])(
  'checkpoint commit preserves the value and only selects for replace=%s',
  (replace) => {
    const input = document.createElement('input');
    document.body.append(input);
    input.value = 'original';
    input.setSelectionRange(2, 2);
    const expected = action.call(input, 'read-input-state');
    input.focus();
    const focus = vi.spyOn(input, 'focus');
    action.call(input, 'commit-input', { replace, expected });
    expect(input.value).toBe('original');
    expect([input.selectionStart, input.selectionEnd]).toEqual(replace ? [0, 8] : [2, 2]);
    expect(focus).not.toHaveBeenCalled();
  },
);

test('fill checkpoint accepts a focus-induced caret change before selecting all', () => {
  const input = document.createElement('input');
  document.body.append(input);
  input.value = 'original';
  input.setSelectionRange(0, 0);
  const expected = action.call(input, 'read-input-state');
  input.focus();
  input.setSelectionRange(8, 8);
  expect(() => action.call(input, 'commit-input', { replace: true, expected })).not.toThrow();
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 8]);
  expect(input.value).toBe('original');
});

test('contenteditable fill accepts a new focused selection while preserving its original text', () => {
  const input = document.createElement('div');
  input.tabIndex = 0;
  input.textContent = 'original';
  Object.defineProperty(input, 'isContentEditable', { value: true });
  document.body.append(input);
  window.getSelection()!.removeAllRanges();
  const expected = action.call(input, 'read-input-state');
  input.focus();
  const range = document.createRange();
  range.setStart(input.firstChild!, 4);
  range.collapse(true);
  window.getSelection()!.addRange(range);
  expect(() => action.call(input, 'commit-input', { replace: true, expected })).not.toThrow();
  expect(window.getSelection()!.toString()).toBe('original');
  expect(input.textContent).toBe('original');
});

test('input checkpoint capture does not focus, select, or change the field', () => {
  const input = document.createElement('textarea');
  document.body.append(input);
  input.value = 'original';
  input.setSelectionRange(1, 4, 'backward');
  const focus = vi.spyOn(input, 'focus');
  const select = vi.spyOn(input, 'select');
  expect(action.call(input, 'read-input-state')).toEqual({
    value: 'original',
    start: 1,
    end: 4,
    direction: 'backward',
  });
  expect(focus).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  expect(input.value).toBe('original');
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

test('shadow-root focus and input work in the element root', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const input = document.createElement('input');
  shadow.append(input);
  input.scrollIntoView = vi.fn();
  action.call(input, 'prepare-input', true);
  expect(shadow.activeElement).toBe(input);
  expect(() => action.call(input, 'check-focus')).not.toThrow();
});

test('native select dispatches input/change and refuses missing or disabled options', () => {
  const select = document.createElement('select');
  select.innerHTML =
    '<option value="a">A</option><option value="b">B</option><optgroup disabled><option value="c">C</option></optgroup>';
  document.body.append(select);
  const events: string[] = [];
  select.addEventListener('input', () => events.push('input'));
  select.addEventListener('change', () => events.push('change'));
  const run = action as unknown as (this: HTMLElement, op: string, arg?: unknown) => any;
  run.call(select, 'select', ['b']);
  expect(select.value).toBe('b');
  expect(events).toEqual(['input', 'change']);
  expect(() => run.call(select, 'select', ['c'])).toThrow('unavailable');
  expect(() => run.call(select, 'select', ['missing'])).toThrow('unavailable');
  expect(select.value).toBe('b');
});

test('inspect returns control state and redacts secrets; writing password or OTP is refused', () => {
  for (const html of [
    '<input type="password" value="secret">',
    '<input autocomplete="one-time-code" value="123456">',
  ]) {
    document.body.innerHTML = html;
    const input = document.querySelector('input')!;
    const state = action.call(input, 'inspect') as {
      value: string;
      sensitive: boolean;
      editable: boolean;
    };
    expect(state.value).toBe('[redacted]');
    expect(state.sensitive).toBe(true);
    expect(state.editable).toBe(false);
    expect(() => action.call(input, 'prepare-input', true)).toThrow('handled by the user');
  }
  document.body.innerHTML = '<input type="checkbox" checked disabled>';
  const state = action.call(document.querySelector('input')!, 'inspect') as {
    checked: boolean;
    disabled: boolean;
  };
  expect(state.checked).toBe(true);
  expect(state.disabled).toBe(true);
});

test('media inspection reports playback changes without operating the player or exposing its URL', () => {
  const video = document.createElement('video');
  video.src = 'https://example.test/private-video?token=secret';
  document.body.append(video);
  const play = vi.spyOn(video, 'play');
  const pause = vi.spyOn(video, 'pause');
  let paused = false;
  Object.defineProperties(video, {
    paused: { get: () => paused },
    currentTime: { value: 12.5 },
    duration: { value: 60 },
    readyState: { value: 4 },
    networkState: { value: 1 },
  });
  expect(action.call(video, 'inspect')).toMatchObject({
    media: {
      paused: false,
      ended: false,
      seeking: false,
      currentTime: 12.5,
      duration: 60,
      readyState: 4,
      networkState: 1,
      muted: false,
      volume: 1,
      playbackRate: 1,
      error: null,
    },
  });
  paused = true;
  const state = action.call(video, 'inspect');
  expect(state).toMatchObject({ media: { paused: true } });
  expect(JSON.stringify(state)).not.toContain('private-video');
  expect(JSON.stringify(state)).not.toContain('secret');
  expect(play).not.toHaveBeenCalled();
  expect(pause).not.toHaveBeenCalled();
});

test.each([
  { duration: NaN, readyState: 0, ended: false, error: null },
  { duration: Infinity, readyState: 2, ended: false, error: null },
  { duration: 60, readyState: 4, ended: true, error: null },
  { duration: NaN, readyState: 0, ended: false, error: { code: 4 } },
])('media inspection preserves loading, ended and error facts: %j', (facts) => {
  const audio = document.createElement('audio');
  document.body.append(audio);
  for (const [key, value] of Object.entries(facts)) Object.defineProperty(audio, key, { value });
  expect(action.call(audio, 'inspect')).toMatchObject({
    media: { ...facts, duration: Number.isFinite(facts.duration) ? facts.duration : null },
  });
});

test('media in another frame is inspected in its own realm', () => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const video = frame.contentDocument!.createElement('video');
  frame.contentDocument!.body.append(video);
  expect(video instanceof HTMLMediaElement).toBe(false);
  expect(action.call(video, 'inspect')).toMatchObject({ media: { paused: true, readyState: 0 } });
});

test('icon controls expose bounded labels without pretending to be native media', () => {
  const button = document.createElement('button');
  button.setAttribute('aria-label', 'Pause');
  button.title = 'x'.repeat(600);
  document.body.append(button);
  expect(action.call(button, 'inspect')).toMatchObject({
    text: '',
    ariaLabel: 'Pause',
    title: 'x'.repeat(512),
    media: undefined,
  });
});
