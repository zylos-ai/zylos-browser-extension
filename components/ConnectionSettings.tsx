import { useState } from 'react';
import { useI18n } from './LanguageProvider';
import { languagePreference } from '../utils/i18n';
import type { RemoteState } from '../utils/remote';

export function ConnectionSettings({
  state,
  saving,
  pending,
  onSave,
  onToggle,
  onClear,
}: {
  state: RemoteState;
  saving: boolean;
  pending: boolean;
  onSave: (relayUrl: string, key: string) => Promise<boolean>;
  onToggle: () => void;
  onClear: () => void;
}) {
  const { t, preference, changeLanguage, savingLanguage, languageError } = useI18n();
  const [relayUrl, setRelayUrl] = useState(state.relayUrl || 'ws://127.0.0.1:3802/ext');
  const [key, setKey] = useState('');
  return (
    <main id="settings" className="settings-page">
      <div className="settings-intro">
        <h1 className="text-title">{t('connectTitle')}</h1>
        <p className="text-muted localized-description">{t('connectDescription')}</p>
      </div>
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!saving && relayUrl.trim() && key.trim())
            void onSave(relayUrl, key).then((ok) => {
              if (ok) setKey('');
            });
        }}
      >
        <div className="settings-fields">
          <label className="form-field" htmlFor="relay-url">
            <span>{t('relayUrl')}</span>
            <input
              className="input"
              id="relay-url"
              value={relayUrl}
              onChange={(e) => setRelayUrl(e.target.value)}
              placeholder="ws://127.0.0.1:3802/ext"
              autoComplete="off"
              spellCheck={false}
              required
              disabled={saving}
            />
          </label>
          <label className="form-field" htmlFor="access-key">
            <span>{t('accessKey')}</span>
            <input
              className="input"
              id="access-key"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={state.keyId ? t('savedKeyPlaceholder') : t('keyPlaceholder')}
              aria-describedby="key-hint"
              autoComplete="off"
              spellCheck={false}
              required
              disabled={saving}
            />
          </label>
          <p id="key-hint" className="text-caption text-muted">
            {t('keyHint')}
          </p>
        </div>
        <button
          className="btn btn-primary save-button"
          type="submit"
          disabled={saving || !relayUrl.trim() || !key.trim()}
        >
          {saving ? t('saving') : state.enabled ? t('saveConnect') : t('saveSettings')}
        </button>
      </form>
      <aside className="card connection-note">
        <h2 className="text-label">{t('connectionNoteTitle')}</h2>
        <p className="text-muted">{t('connectionNote')}</p>
      </aside>
      <section className="language-settings" aria-label={t('language')}>
        <label className="form-field" htmlFor="interface-language">
          <span>{t('language')}</span>
          <select
            id="interface-language"
            className="select"
            value={preference}
            disabled={savingLanguage}
            aria-describedby="language-hint"
            onChange={(e) => void changeLanguage(languagePreference(e.target.value))}
          >
            <option value="auto">{t('autoLanguage')}</option>
            <option value="zh-CN">中文</option>
            <option value="en">English</option>
          </select>
        </label>
        <p id="language-hint" className="text-caption text-muted">
          {t('languageHint')}
        </p>
        {languageError && (
          <p className="language-error text-caption" role="alert">
            {t('languageSaveFailed')}
          </p>
        )}
      </section>
      {state.configured && (
        <section className="connection-management" aria-label={t('manageConnection')}>
          <button className="btn secondary-button" disabled={pending} onClick={onToggle}>
            {state.enabled ? t('disableExtension') : t('enableExtension')}
          </button>
          {state.chat.length > 0 && (
            <button
              className="btn btn-ghost clear-chat-button"
              disabled={pending}
              onClick={onClear}
            >
              {t('clearChat')}
            </button>
          )}
        </section>
      )}
    </main>
  );
}
