import { useEffect, useRef, useState } from 'react';
import {
  readAttachmentFile,
  validateAttachmentFiles,
  type DraftAttachment,
} from '../utils/file-attachments';

export function useFileAttachments(reservedSlots: number) {
  const [files, setFiles] = useState<DraftAttachment[]>([]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const current = useRef(files);
  const reserved = useRef(reservedSlots);
  reserved.current = reservedSlots;
  const pending = useRef(0);
  const queue = useRef(Promise.resolve());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function update(next: DraftAttachment[]) {
    current.current = next;
    setFiles(next);
  }
  function validate(files: File[]) {
    validateAttachmentFiles(
      files,
      current.current.length + reserved.current,
      current.current.reduce((total, image) => total + image.attachment.bytes, 0),
    );
  }
  function addFiles(files: File[]) {
    if (!files.length) return;
    pending.current++;
    setReading(true);
    setError('');
    queue.current = queue.current.then(async () => {
      if (!mounted.current) return;
      try {
        validate(files);
        const added = await Promise.all(files.map(readAttachmentFile));
        if (!mounted.current) return;
        validate(files);
        update([...current.current, ...added]);
      } catch (error) {
        if (mounted.current)
          setError(error instanceof Error ? error.message : 'ui.error.attachmentReadFailed');
      } finally {
        pending.current--;
        if (mounted.current) setReading(pending.current > 0);
      }
    });
  }
  function remove(ids: string[]) {
    update(current.current.filter((image) => !ids.includes(image.attachment.id)));
    setError('');
  }
  return { files, reading, error, addFiles, remove, isReading: () => pending.current > 0 };
}
