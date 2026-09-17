import { expect, test, vi } from 'vitest';
import { ToolActivity } from '../../utils/tool-activity';
import { TOOL_STEPS_CAP, type ChatEntry } from '../../utils/remote';

test('tool history excludes input/output payloads, labels retries, and bounds stored steps', () => {
  const chat: ChatEntry[] = [];
  const activity = new ToolActivity(() => chat, vi.fn());
  expect(activity.begin('info', {})).toBeUndefined();
  activity.begin('fill', { ref: 'e1', text: 'secret input' })!.finish();
  activity
    .begin('open', {
      url: 'https://user:password@example.com/path?token=secret#fragment',
      screenshot: { data: 'BASE64' },
    })!
    .finish();
  activity.begin('click', { ref: 'e2' })!.finish(undefined, true);
  const saved = JSON.stringify(chat);
  for (const secret of ['secret', 'password', 'BASE64', 'fragment'])
    expect(saved).not.toContain(secret);
  expect(chat[0]!.toolRun!.steps[1]!.target).toBe('https://example.com/path');
  expect(chat[0]!.toolRun!.steps[2]!.replayed).toBe(true);
  for (let i = 0; i < TOOL_STEPS_CAP; i++) activity.begin('snapshot', {})!.finish();
  expect(chat[0]!.toolRun).toMatchObject({ total: TOOL_STEPS_CAP + 3, failed: 0 });
  expect(chat[0]!.toolRun!.steps).toHaveLength(TOOL_STEPS_CAP);
  expect(chat[0]!.toolRun!.steps[0]!.number).toBe(4);
});

test('ending a run distinguishes cancelled queued work from unconfirmed in-flight work', () => {
  const chat: ChatEntry[] = [{ role: 'user', text: 'Go', ts: 0 }];
  const activity = new ToolActivity(() => chat, vi.fn());
  const first = activity.begin('snapshot', {})!;
  first.start();
  const next = activity.begin('click', {})!;
  activity.end('stopped');
  first.finish();
  next.start();
  next.finish();
  expect(chat[1]!.toolRun!.steps.map((s) => s.status)).toEqual(['interrupted', 'cancelled']);
  expect(activity.begin('info', {})).toBeUndefined();
});

test('only identical successful retries in the same page context resolve previous errors', () => {
  const chat: ChatEntry[] = [];
  let context = 'task:tab:page';
  const activity = new ToolActivity(
    () => chat,
    vi.fn(),
    () => context,
  );
  const execute = (params: Record<string, unknown>, error?: string, replayed?: boolean) => {
    const call = activity.begin('fill', params)!;
    call.start();
    call.finish(error, replayed);
  };
  execute({ ref: 'e1', text: 'private original' }, 'STALE_REF');
  execute({ ref: 'e1', text: 'a different value' });
  expect(chat[0]!.toolRun!.steps[0]!.recovered).toBeUndefined();
  execute({ text: 'private original', ref: 'e1' }, undefined, true);
  expect(chat[0]!.toolRun!.steps[0]!.recovered).toBeUndefined();
  context = 'another tab';
  execute({ ref: 'e1', text: 'private original' });
  expect(chat[0]!.toolRun!.steps[0]!.recovered).toBeUndefined();
  context = 'task:tab:page';
  execute({ text: 'private original', ref: 'e1' });
  expect(chat[0]!.toolRun).toMatchObject({ failed: 1, recovered: 1 });
  expect(chat[0]!.toolRun!.steps[0]).toMatchObject({
    status: 'error',
    errorCode: 'STALE_REF',
    recovered: true,
  });
  expect(JSON.stringify(chat)).not.toContain('private original');
  expect(JSON.stringify(chat)).not.toContain('a different value');
});

test('navigation and missing context prevent speculative error recovery', () => {
  const chat: ChatEntry[] = [];
  const activity = new ToolActivity(
    () => chat,
    vi.fn(),
    () => 'same-url',
  );
  const call = (method: string, error?: string) => {
    const s = activity.begin(method, {})!;
    s.start();
    s.finish(error);
  };
  call('snapshot', 'TIMEOUT');
  call('reload');
  call('snapshot');
  expect(chat[0]!.toolRun!.steps[0]!.recovered).toBeUndefined();
  const legacy: ChatEntry[] = [];
  const noContext = new ToolActivity(() => legacy, vi.fn());
  for (const error of ['TIMEOUT', undefined]) {
    const s = noContext.begin('snapshot', {})!;
    s.start();
    s.finish(error);
  }
  expect(legacy[0]!.toolRun!.steps[0]!.recovered).toBeUndefined();
});
