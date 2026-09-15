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
  onSend,
  inputRef,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  connected: boolean;
  sending: boolean;
  onSend: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const { t } = useI18n();
  const composing = useRef(false);
  const disabled = !connected || !draft.trim() || sending;
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
        onSend();
      }}
    >
      <div className="composer-field">
        <textarea
          ref={inputRef}
          id="message"
          rows={1}
          aria-label={t('message')}
          aria-describedby="composer-hint"
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
          <span className="text-caption text-muted">{t('composerTagline')}</span>
          <button
            id="send"
            className="btn btn-primary send-button"
            type="submit"
            disabled={disabled}
            aria-label={sending ? t('sending') : t('sendMessage')}
            title={t('sendMessage')}
          >
            {sending ? (
              <span className="loading loading-spinner loading-xs" aria-hidden="true" />
            ) : (
              <img src={disabled ? sendDisabledIcon : sendIcon} width="18" height="18" alt="" />
            )}
          </button>
        </div>
      </div>
      <p id="composer-hint" className="text-caption text-muted">
        {t('keyboardHint')}
      </p>
    </form>
  );
}
