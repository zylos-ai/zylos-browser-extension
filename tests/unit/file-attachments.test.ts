import { afterEach, expect, test, vi } from 'vitest';
import { readAttachmentFile, validateAttachmentFiles } from '../../utils/file-attachments';
import { attachmentSchema } from '../../utils/attachments';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
const file = (name = 'image.png', type = 'image/png') =>
  new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], name, { type });
afterEach(() => vi.unstubAllGlobals());

test('validates nonempty bytes, aggregate size and shared quote/file slots before reading', () => {
  expect(() => validateAttachmentFiles([file()], 7, 0)).not.toThrow();
  expect(() => validateAttachmentFiles([file()], 8, 0)).toThrow('tooManyAttachments');
  expect(() => validateAttachmentFiles([file()], 0, 5_250_000)).toThrow('attachmentsTooLarge');
  expect(() =>
    validateAttachmentFiles([new File([], 'empty.png', { type: 'image/png' })], 0, 0),
  ).toThrow('attachmentEmpty');
  expect(() => validateAttachmentFiles([file('image.svg', 'image/svg+xml')], 0, 0)).not.toThrow();
  expect(() => validateAttachmentFiles([file('image.HEIC', 'image/heic')], 0, 0)).not.toThrow();
  expect(() => validateAttachmentFiles([file('image.PNG', '')], 0, 0)).not.toThrow();
});

test.each([
  ['report.pdf', 'application/pdf', 'application/pdf'],
  ['report.docx', '', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['budget.xlsx', '', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['archive.zip', 'application/zip', 'application/zip'],
  ['notes.md', 'text/plain', 'text/plain'],
  ['chart.svg', 'image/svg+xml', 'image/svg+xml'],
  ['photo.HEIC', '', 'image/heic'],
  ['data.custom', '', 'application/octet-stream'],
  ['LICENSE', '', 'application/octet-stream'],
  ['data.custom', 'invalid mime', 'application/octet-stream'],
  ['notes.txt', 'text/plain;charset=utf-8', 'text/plain'],
])('preserves %s as a file without attempting image decoding', async (name, declared, mimeType) => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  const result = await readAttachmentFile(new File([bytes], name, { type: declared }));
  expect(result.attachment).toMatchObject({
    name,
    type: 'file',
    mimeType,
    bytes: 5,
    data: 'AAF/gP8=',
  });
  expect(result.preview).toBeUndefined();
  expect(attachmentSchema.safeParse(result.attachment).success).toBe(true);
});

test('rejects non-image contents and mismatched MIME before decoding a thumbnail', async () => {
  await expect(
    readAttachmentFile(new File(['not an image'], 'fake.png', { type: 'image/png' })),
  ).rejects.toThrow('imageReadFailed');
  await expect(readAttachmentFile(file('fake.jpg', 'image/jpeg'))).rejects.toThrow(
    'imageReadFailed',
  );
});

test('preserves original image bytes, sanitizes the filename and creates a separate small thumbnail', async () => {
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 2048;
      naturalHeight = 1024;
      onload?: () => void;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect: vi.fn(),
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    'data:image/jpeg;base64,/9j/2Q==',
  );
  const result = await readAttachmentFile(file('folder/image.png'));
  expect(result.attachment).toMatchObject({
    name: 'folder_image.png',
    type: 'image',
    mimeType: 'image/png',
    bytes: file().size,
    data: png,
  });
  expect(result.preview).toBe('data:image/jpeg;base64,/9j/2Q==');
  expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 256, 128);
});

test('a supported header that cannot be decoded is reported as an unreadable image', async () => {
  vi.stubGlobal(
    'Image',
    class {
      onerror?: () => void;
      set src(value: string) {
        if (value) queueMicrotask(() => this.onerror?.());
      }
    },
  );
  await expect(readAttachmentFile(file())).rejects.toThrow('imageReadFailed');
});
