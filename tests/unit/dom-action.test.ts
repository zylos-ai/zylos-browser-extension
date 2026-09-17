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
