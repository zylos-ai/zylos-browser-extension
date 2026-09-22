import { z } from 'zod';
import { pageSelectionSchema, type PageSelection } from './page-selection';

// The same attachment envelope is used by the composer, history and Agent payload.
// Binary data is transport-only: history keeps metadata, and Remote materializes it.
export const ATTACHMENT_CAPABILITY = 'attachments-v1';
export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 5_250_000; // 7 MB base64, below the 8 MiB WS frame cap.
const idSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const sourceSchema = pageSelectionSchema.omit({ text: true, truncated: true });
export const quoteAttachmentSchema = z
  .object({
    id: idSchema,
    type: z.literal('quote'),
    text: pageSelectionSchema.shape.text,
    truncated: z.boolean(),
    source: sourceSchema,
  })
  .strict();
const binaryMetadata = {
  id: idSchema,
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((s) => !/[\\/\u0000-\u001f]/.test(s)),
  mimeType: z
    .string()
    .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/)
    .max(128),
  bytes: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
};
const imageMetadataSchema = z
  .object({
    ...binaryMetadata,
    type: z.literal('image'),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  })
  .strict();
const fileMetadataSchema = z
  .object({
    ...binaryMetadata,
    type: z.literal('file'),
    mimeType: binaryMetadata.mimeType.refine((s) => !s.startsWith('image/')),
  })
  .strict();
const dataSchema = z
  .string()
  .min(4)
  .max(7_000_000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)
  .refine((s) => s.length % 4 === 0);
export const attachmentSchema = z
  .discriminatedUnion('type', [
    quoteAttachmentSchema,
    imageMetadataSchema.extend({ data: dataSchema }),
    fileMetadataSchema.extend({ data: dataSchema }),
  ])
  .superRefine((a, ctx) => {
    if (a.type !== 'quote' && base64Bytes(a.data) !== a.bytes)
      ctx.addIssue({ code: 'custom', message: 'Attachment size does not match its data' });
  });
export const attachmentsSchema = z
  .array(attachmentSchema)
  .max(MAX_ATTACHMENTS)
  .superRefine((items, ctx) => {
    if (new Set(items.map((a) => a.id)).size !== items.length)
      ctx.addIssue({ code: 'custom', message: 'Attachment IDs must be unique' });
    if (
      items.reduce((total, a) => total + (a.type === 'quote' ? 0 : a.bytes), 0) >
      MAX_ATTACHMENT_BYTES
    )
      ctx.addIssue({ code: 'custom', message: 'Attachments exceed the message size limit' });
  });
export const storedAttachmentsSchema = z
  .array(
    z.discriminatedUnion('type', [quoteAttachmentSchema, imageMetadataSchema, fileMetadataSchema]),
  )
  .max(MAX_ATTACHMENTS);
export type Attachment = z.infer<typeof attachmentSchema>;
export type QuoteAttachment = z.infer<typeof quoteAttachmentSchema>;
export type StoredAttachment = z.infer<typeof storedAttachmentsSchema>[number];

export function base64Bytes(data: string) {
  return (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}
export function selectionAttachment(
  selection: PageSelection,
  id: string = crypto.randomUUID(),
): QuoteAttachment {
  const { text, truncated, ...source } = selection;
  return { id, type: 'quote', text, truncated, source };
}
export function attachmentSelection(attachment: QuoteAttachment): PageSelection {
  return { ...attachment.source, text: attachment.text, truncated: attachment.truncated };
}
export function storedAttachments(attachments: Attachment[]): StoredAttachment[] {
  return attachments.map((a) => {
    if (a.type === 'quote') return a;
    const { data: _data, ...metadata } = a;
    return metadata;
  });
}
export function agentAttachments(attachments: Attachment[], contextId: string) {
  return attachments.map((a) =>
    a.type === 'quote'
      ? {
          id: a.id,
          type: a.type,
          text: a.text,
          truncated: a.truncated,
          source: { contextId, url: a.source.url, title: a.source.title },
        }
      : a,
  );
}
export function screenshotAttachment(data: string) {
  return {
    id: crypto.randomUUID(),
    type: 'image' as const,
    name: 'screenshot.png',
    mimeType: 'image/png' as const,
    bytes: base64Bytes(data),
    data,
  };
}
