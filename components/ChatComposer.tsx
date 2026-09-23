import { useLayoutEffect, useRef } from 'react';
import sendIcon from '../assets/brand/send.svg';
import sendDisabledIcon from '../assets/brand/send-disabled.svg';
import { useI18n } from './LanguageProvider';
import { MAX_CHAT_TEXT } from '../utils/remote';

export function ChatComposer({
  draft,
  onDraftChange,
  connected,
  sending,
  busy,
  onSend,
  inputRef,
  preview,
  attachments,
  onStop,
  stopping = false,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  connected: boolean;
  sending: boolean;
  busy: boolean;
  onSend: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  preview?: React.ReactNode;
  attachments?: React.ReactNode;
  onStop?: () => void;
  stopping?: boolean;
}) {
  const { t } = useI18n();
  const composing = useRef(false);
  const active = sending || busy || stopping;
  const disabled = !connected || !draft.trim() || active;
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }, [draft, inputRef]);

  return (
    <form
      id="chat-form"
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) onSend();
      }}
    >
      <div className="composer-field">
        {preview}
        {attachments}
        <textarea
          ref={inputRef}
          id="message"
          rows={1}
          aria-label={t('message')}
          value={draft}
          maxLength={MAX_CHAT_TEXT}
          placeholder={connected ? t('messagePlaceholder') : t('disconnectedPlaceholder')}
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
          <button
            id="send"
            className="btn send-button"
            type={active ? 'button' : 'submit'}
            disabled={active ? stopping || !onStop : disabled}
            onClick={active ? onStop : undefined}
            aria-label={stopping ? t('stopping') : active ? t('stopTask') : t('sendMessage')}
            title={stopping ? t('stopping') : active ? t('stopTask') : t('sendMessage')}
            aria-busy={stopping || undefined}
          >
            {stopping ? (
              <span className="loading loading-spinner loading-xs" aria-hidden="true" />
            ) : active ? (
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
      </div>
    </form>
  );
}
