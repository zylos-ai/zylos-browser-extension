import { useLayoutEffect, useRef, useState } from 'react';
import sendIcon from '../assets/brand/send.svg';
import sendDisabledIcon from '../assets/brand/send-disabled.svg';
import { useI18n } from './LanguageProvider';
import { MAX_CHAT_TEXT } from '../utils/remote';
import { type DraftAttachment } from '../utils/file-attachments';
import { FileAttachment } from './FileAttachment';

export function ChatComposer({
  draft,
  onDraftChange,
  connected,
  sending,
  busy,
  onSend,
  onStop,
  inputRef,
  preview,
  attachments,
  steeringSupported = false,
  stopping = false,
  files = [],
  onAddFiles,
  onRemoveFile,
  readingAttachments = false,
  attachmentError = '',
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  connected: boolean;
  sending: boolean;
  busy: boolean;
  onSend: () => void;
  onStop: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  preview?: React.ReactNode;
  attachments?: React.ReactNode;
  steeringSupported?: boolean;
  stopping?: boolean;
  files?: DraftAttachment[];
  onAddFiles?: (files: File[]) => void;
  onRemoveFile?: (id: string) => void;
  readingAttachments?: boolean;
  attachmentError?: string;
}) {
  const { t, errorText } = useI18n();
  const composing = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const showStop = stopping || (busy && !draft.trim() && !files.length && !readingAttachments);
  const disabled =
    !connected ||
    (!draft.trim() && !files.length) ||
    sending ||
    stopping ||
    (busy && !steeringSupported) ||
    readingAttachments;
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }, [draft, inputRef]);

  return (
    <form
      id="chat-form"
      className={`composer${dragging ? ' is-dragging' : ''}`}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.files);
        if (!files.length || !onAddFiles) return;
        event.preventDefault();
        if (connected) onAddFiles(files);
      }}
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        dragDepth.current++;
        if (connected && onAddFiles) setDragging(true);
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = connected && onAddFiles ? 'copy' : 'none';
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(event) => {
        dragDepth.current = 0;
        setDragging(false);
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        if (connected) onAddFiles?.(Array.from(event.dataTransfer.files));
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) onSend();
      }}
    >
      <div className="composer-field">
        {preview}
        {attachments}
        {readingAttachments && (
          <p className="attachment-status" role="status">
            {t('readingAttachments')}
          </p>
        )}
        {attachmentError && (
          <p className="attachment-error" role="alert">
            {errorText(attachmentError)}
          </p>
        )}
        <textarea
          ref={inputRef}
          id="message"
          rows={1}
          aria-label={t('message')}
          value={draft}
          maxLength={MAX_CHAT_TEXT}
          placeholder={
            connected
              ? t(
                  files.length
                    ? 'attachmentMessagePlaceholder'
                    : busy && steeringSupported
                      ? 'steerPlaceholder'
                      : 'messagePlaceholder',
                )
              : t('disconnectedPlaceholder')
          }
          disabled={!connected}
          onChange={(e) => onDraftChange(e.target.value)}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !composing.current &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              if (!disabled) onSend();
            }
          }}
        />
        <div className="composer-toolbar">
          {onAddFiles && (
            <>
              <input
                ref={fileInputRef}
                id="attachment-upload"
                type="file"
                multiple
                hidden
                disabled={!connected || readingAttachments}
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = '';
                  onAddFiles(files);
                  inputRef.current?.focus();
                }}
              />
              <button
                type="button"
                className="btn btn-ghost attach-button"
                disabled={!connected || readingAttachments}
                onClick={() => fileInputRef.current?.click()}
                aria-label={t('addAttachments')}
                title={t('addAttachmentsHint')}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </>
          )}
          {files.length > 0 && (
            <ul className="attachment-list draft-attachments" aria-label={t('attachedFiles')}>
              {files.map(({ attachment, preview }) => (
                <li
                  key={attachment.id}
                  className={`attachment-item${attachment.type === 'file' ? ' is-file' : ''}`}
                  title={attachment.name}
                >
                  {preview ? (
                    <img src={preview} alt={attachment.name} width="40" height="40" />
                  ) : (
                    <FileAttachment name={attachment.name} bytes={attachment.bytes} compact />
                  )}
                  <button
                    type="button"
                    className="attachment-item-remove"
                    aria-label={t('removeAttachment', { name: attachment.name })}
                    title={t('removeAttachment', { name: attachment.name })}
                    onClick={() => onRemoveFile?.(attachment.id)}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            id="send"
            className="btn send-button"
            type={showStop ? 'button' : 'submit'}
            disabled={showStop ? stopping : disabled}
            onClick={showStop ? onStop : undefined}
            aria-label={t(showStop ? (stopping ? 'stopping' : 'stopTask') : 'sendMessage')}
            title={t(showStop ? (stopping ? 'stopping' : 'stopTask') : 'sendMessage')}
          >
            {showStop ? (
              <svg
                width="18"
                height="18"
                viewBox="0 0 18 18"
                fill="currentColor"
                aria-hidden="true"
              >
                <rect x="4" y="4" width="10" height="10" rx="2" />
              </svg>
            ) : (
              <img src={disabled ? sendDisabledIcon : sendIcon} width="18" height="18" alt="" />
            )}
          </button>
        </div>
        {dragging && (
          <div className="attachment-drop-hint" role="status">
            {t('dropAttachments')}
          </div>
        )}
      </div>
    </form>
  );
}
