// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  attachmentsSchema,
  storedAttachments,
  agentAttachments,
  selectionAttachment,
} from '../../utils/attachments';
import { chatEntrySchema, remoteRequestSchema } from '../../utils/remote';

const selection = {
  text: 'Exact selected text',
  truncated: false,
  tabId: 3,
  documentId: 'document-1',
  selectionVersion: 9,
  url: 'https://example.com/article',
  title: 'Article',
};
const file = {
  id: 'file-1',
  type: 'file' as const,
  name: 'notes.txt',
  mimeType: 'text/plain',
  bytes: 5,
  data: 'aGVsbG8=',
};
describe('message attachment boundaries', () => {
  it('keeps quote provenance locally, sends only the bound source to the Agent, and omits binary data from history', () => {
    const attachments = attachmentsSchema.parse([selectionAttachment(selection, 'quote-1'), file]);
    expect(
      remoteRequestSchema.parse({
        type: 'remote-chat-send',
        message: { role: 'user', content: [{ type: 'text', text: 'Compare' }, ...attachments] },
      }),
    ).toHaveProperty('message.content', [{ type: 'text', text: 'Compare' }, ...attachments]);
    expect(agentAttachments(attachments, 'task-1')).toEqual([
      {
        id: 'quote-1',
        type: 'quote',
        text: selection.text,
        truncated: false,
        source: { contextId: 'task-1', url: selection.url, title: selection.title },
      },
      file,
    ]);
    const history = storedAttachments(attachments);
    expect(history[0]).toHaveProperty('source.documentId', 'document-1');
    expect(history[1]).not.toHaveProperty('data');
    expect(attachments[1]).toHaveProperty('data', file.data);
  });
  it('migrates old quote history without losing other message fields or duplicating attachments', () => {
    const old = { id: 'm1', role: 'user', text: 'Explain', ts: 1, selection, delivery: 'queued' };
    const migrated = chatEntrySchema.parse(old);
    expect(migrated).not.toHaveProperty('selection');
    expect(migrated.attachments).toEqual([selectionAttachment(selection, 'm1-selection')]);
    expect(migrated.delivery).toBe('queued');
    expect(chatEntrySchema.parse(migrated)).toEqual(migrated);
    expect(chatEntrySchema.parse({ ...old, attachments: migrated.attachments })).toEqual(migrated);
  });
  it('rejects ambiguous IDs, invalid encodings, external paths and oversized inputs before sending', () => {
    for (const invalid of [
      [file, file],
      [{ ...file, bytes: 6 }],
      [{ ...file, data: 'http://example.com/file' }],
      [{ ...file, path: '/Users/owner/notes.txt' }],
      [{ ...file, name: '../notes.txt' }],
      [{ ...file, mimeType: 'image/png' }],
      Array.from({ length: 9 }, (_, i) => ({ ...file, id: `file-${i}` })),
    ])
      expect(attachmentsSchema.safeParse(invalid).success).toBe(false);
  });
});
