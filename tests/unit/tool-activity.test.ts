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
