import {
  IMAGE_MIME_TYPES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_PREVIEW_LENGTH,
  type ImageAttachment,
  type Attachment,
} from './attachments';

export type DraftAttachment = {
  attachment: Exclude<Attachment, { type: 'quote' }>;
  preview?: string;
};

export function validateAttachmentFiles(files: File[], count: number, bytes: number) {
  if (count + files.length > MAX_ATTACHMENTS) throw new Error('ui.error.tooManyAttachments');
  for (const file of files) {
    if (!file.size) throw new Error('ui.error.attachmentEmpty');
    bytes += file.size;
  }
  if (bytes > MAX_ATTACHMENT_BYTES) throw new Error('ui.error.attachmentsTooLarge');
}

function fileMimeType(file: File): string {
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  const fallback: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    heic: 'image/heic',
    avif: 'image/avif',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    zip: 'application/zip',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  const declared = file.type.split(';')[0]?.trim().toLowerCase();
  if (
    declared &&
    declared !== 'application/octet-stream' &&
    declared.length <= 128 &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(declared)
  )
    return declared;
  return fallback[extension ?? ''] || 'application/octet-stream';
}

function readData(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = reader.onabort = () => reject(new Error('ui.error.attachmentReadFailed'));
    reader.readAsDataURL(file);
  });
}

function signatureMatches(data: string, mime: ImageAttachment['mimeType']) {
  const header = atob(data.slice(0, 24));
  switch (mime) {
    case 'image/png':
      return header.startsWith('\x89PNG\r\n\x1a\n');
    case 'image/jpeg':
      return header.startsWith('\xff\xd8\xff');
    case 'image/gif':
      return /^GIF8[79]a/.test(header);
    case 'image/webp':
      return header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
  }
}

function thumbnail(src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => fail(), 15_000);
    function fail() {
      clearTimeout(timer);
      image.onload = image.onerror = null;
      image.src = '';
      reject(new Error('ui.error.imageReadFailed'));
    }
    image.onerror = fail;
    image.onload = () => {
      clearTimeout(timer);
      try {
        if (!image.naturalWidth || !image.naturalHeight) return fail();
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) return fail();
        const scale = Math.min(1, 256 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        // Preserve transparency against the same neutral background used in the UI.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        for (const quality of [0.75, 0.5, 0.25]) {
          const preview = canvas.toDataURL('image/jpeg', quality);
          if (
            preview.startsWith('data:image/jpeg;base64,') &&
            preview.length <= MAX_IMAGE_PREVIEW_LENGTH
          ) {
            resolve(preview);
            return;
          }
        }
        fail();
      } catch {
        fail();
      }
    };
    image.src = src;
  });
}

export async function readAttachmentFile(file: File): Promise<DraftAttachment> {
  validateAttachmentFiles([file], 0, 0);
  const mimeType = fileMimeType(file);
  const data = await readData(file);
  const metadata = {
    id: crypto.randomUUID(),
    name: file.name.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 255) || 'attachment',
    bytes: file.size,
    data,
  };
  if (!IMAGE_MIME_TYPES.includes(mimeType as ImageAttachment['mimeType']))
    return { attachment: { ...metadata, type: 'file', mimeType } };
  const imageMime = mimeType as ImageAttachment['mimeType'];
  if (!signatureMatches(data, imageMime)) throw new Error('ui.error.imageReadFailed');
  const preview = await thumbnail(`data:${imageMime};base64,${data}`);
  return {
    attachment: { ...metadata, type: 'image', mimeType: imageMime },
    preview,
  };
}
