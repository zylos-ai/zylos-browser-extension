// @vitest-environment node
import { expect, test } from 'vitest';
import {
  userMessageSchema,
  messageText,
  messageAttachments,
  agentMessage,
} from '../../utils/agent-message';
import { selectionAttachment } from '../../utils/attachments';
import { remoteRequestSchema } from '../../utils/remote';
test('a user message has ordered content blocks with one validated attachment identity', () => {
  const quote = selectionAttachment(
    {
      text: 'A quote',
      truncated: false,
      tabId: 7,
      documentId: 'doc-7',
      url: 'https://example.com',
      title: 'Page',
    },
    'q1',
  );
  const message = userMessageSchema.parse({
    role: 'user',
    content: [{ type: 'text', text: 'Explain' }, quote, { type: 'text', text: 'in Chinese' }],
  });
  expect(messageText(message)).toBe('Explain\nin Chinese');
  expect(messageAttachments(message)).toEqual([quote]);
  const outgoing = agentMessage('t1', message);
  expect(outgoing.content.map((part) => part.type)).toEqual(['text', 'quote', 'text']);
  expect(outgoing.content[1]).toHaveProperty('source.contextId', 't1');
  expect(JSON.stringify(outgoing)).not.toContain('doc-7');
  expect(
    userMessageSchema.safeParse({ ...message, content: [...message.content, quote] }).success,
  ).toBe(false);
});
test('the panel rejects mixed or old input structures and oversized combined text', () => {
  expect(
    remoteRequestSchema.safeParse({ type: 'remote-chat-send', text: 'old format' }).success,
  ).toBe(false);
  const message = { role: 'user', content: [{ type: 'text', text: 'Hello' }] };
  expect(
    remoteRequestSchema.safeParse({ type: 'remote-chat-send', message, text: 'duplicate' }).success,
  ).toBe(false);
  expect(
    userMessageSchema.safeParse({
      role: 'user',
      content: [
        { type: 'text', text: 'x'.repeat(5000) },
        { type: 'text', text: 'y'.repeat(5000) },
      ],
    }).success,
  ).toBe(false);
});
