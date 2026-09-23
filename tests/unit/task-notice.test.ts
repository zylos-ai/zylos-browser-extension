import { expect, test } from 'vitest';
import { formatTaskNotice, type TaskNotice } from '../../utils/task-notice';
import { chatEntrySchema } from '../../utils/remote';

test('saved extension notices can switch languages without changing their text fallback', () => {
  const notices: TaskNotice[] = [
    { kind: 'time-limit' },
    { kind: 'execution-limit' },
    { kind: 'interrupted' },
    ...[
      'DECISION_TIMEOUT',
      'DECISION_WAIT_TIMEOUT',
      'SEND_FAILED',
      'AGENT_UNAVAILABLE',
      'AGENT_STOPPING',
      'TURN_BUSY',
      'DECISION_BUSY',
      'C4_DELIVERY_FAILED',
      'C4_DELIVERY_TIMEOUT',
      'C4_DELIVERY_UNCONFIRMED',
      'ATTACHMENT_FAILED',
      'AGENT_REQUEST_TOO_LARGE',
      'BAD_AGENT_REQUEST',
      'EXT_OFFLINE',
      'STALE_DECISION',
      'CUSTOM_ERROR',
    ].map((code) => ({ kind: 'request-failed' as const, code })),
  ];
  for (const notice of notices) {
    const fallback = formatTaskNotice('zh-CN', notice);
    const saved = chatEntrySchema.parse(
      JSON.parse(JSON.stringify({ role: 'assistant', text: fallback, notice, ts: 1 })),
    );
    expect(saved.notice).toEqual(notice);
    expect(formatTaskNotice('en', saved.notice!)).not.toMatch(/\p{Script=Han}|ui\.error|\{\w+\}/u);
    expect(formatTaskNotice('zh-CN', saved.notice!)).toBe(fallback);
    expect(saved.text).toBe(fallback);
  }
});

test('ordinary messages and older histories are not reclassified by their text', () => {
  const text = formatTaskNotice('zh-CN', { kind: 'time-limit' });
  const saved = chatEntrySchema.parse({ role: 'assistant', text, ts: 1 });
  expect(saved.notice).toBeUndefined();
  expect(saved.text).toBe(text);
  expect(formatTaskNotice('en', { kind: 'request-failed', code: 'constructor' })).toContain(
    'constructor',
  );
});
