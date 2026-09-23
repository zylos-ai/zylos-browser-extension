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
}: {
  state: RemoteState;
  saving: boolean;
  pending: boolean;
  onSave: (relayUrl: string, key: string) => Promise<boolean>;
  onToggle: () => void;
}) {
  const { t, preference, changeLanguage, savingLanguage, languageError } = useI18n();
  const [relayUrl, setRelayUrl] = useState(state.relayUrl || 'ws://127.0.0.1:3802/ext');
  const [key, setKey] = useState('');
  return (
    <main id="settings" className="settings-page" aria-labelledby="settings-title">
      <div className="settings-intro">
        <h1 id="settings-title">{state.configured ? t('settings') : t('connectTitle')}</h1>
        <p>{state.configured ? t('settingsDescription') : t('connectDescription')}</p>
      </div>
      <section className="settings-section" aria-labelledby="connection-heading">
        <h2 id="connection-heading">{t('agentConnection')}</h2>
        <form
          className="settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pending && relayUrl.trim() && key.trim())
              void onSave(relayUrl, key).then((ok) => {
                if (ok) setKey('');
              });
          }}
        >
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
              disabled={pending}
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
              disabled={pending}
            />
            <span id="key-hint" className="settings-hint">
              {t('keyHint')}
            </span>
          </label>
          <button
            className="btn btn-primary save-button"
            type="submit"
            disabled={pending || !relayUrl.trim() || !key.trim()}
          >
            {saving ? t('saving') : state.enabled ? t('saveConnect') : t('saveSettings')}
          </button>
        </form>
      </section>
      <section
        className="settings-section preferences-settings"
        aria-labelledby="preferences-heading"
      >
        <h2 id="preferences-heading">{t('preferences')}</h2>
        <div className="settings-row language-settings">
          <div className="settings-copy">
            <label htmlFor="interface-language">{t('language')}</label>
            <p id="language-hint" className="settings-hint">
              {t('languageHint')}
            </p>
          </div>
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
        </div>
        {languageError && (
          <p className="language-error settings-hint" role="alert">
            {t('languageSaveFailed')}
          </p>
        )}
        {state.configured && (
          <div className="settings-row connection-management">
            <div className="settings-copy">
              <label id="connection-enabled-label" htmlFor="connection-enabled">
                {t('connectionEnabled')}
              </label>
              <p id="connection-enabled-hint" className="settings-hint">
                {t('connectionEnabledHint')}
              </p>
            </div>
            <button
              id="connection-enabled"
              className="connection-toggle"
              type="button"
              role="switch"
              aria-checked={state.enabled}
              aria-labelledby="connection-enabled-label"
              aria-describedby="connection-enabled-hint"
              disabled={pending}
              onClick={onToggle}
            >
              <span className="settings-switch-track" aria-hidden="true">
                <span />
              </span>
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
