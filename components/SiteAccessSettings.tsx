import { useEffect, useState } from 'react';
import type { RemoteRequest, RemoteState } from '../utils/remote';
import { useI18n } from './LanguageProvider';
import './site-access.css';

export function SiteAccessSettings({
  state,
  pending,
  onChange,
}: {
  state: RemoteState;
  pending: boolean;
  onChange?: (request: RemoteRequest) => void;
}) {
  const { t, locale } = useI18n();
  const [origin, setOrigin] = useState('');
  const [mode, setMode] = useState<'read-only' | 'interactive'>('read-only');
  const [duration, setDuration] = useState(15);
  const [now, setNow] = useState(Date.now);
  const grants = state.siteAccess?.grants ?? [];
  const audit = state.siteAccess?.audit ?? [];
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const time = (at: number) => new Date(at).toLocaleString(locale);
  const disabled = pending || !onChange;
  return (
    <section
      className="settings-section site-access-settings"
      aria-labelledby="site-access-heading"
    >
      <div>
        <h2 id="site-access-heading">{t('siteAccess')}</h2>
        <p className="settings-hint">{t('siteAccessScope')}</p>
      </div>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || !origin.trim()) return;
          onChange?.({
            type: 'remote-site-access-grant',
            origin: origin.trim(),
            mode,
            durationMinutes: duration,
          });
        }}
      >
        <label className="form-field" htmlFor="site-access-origin">
          <span>{t('siteAccessOrigin')}</span>
          <input
            id="site-access-origin"
            className="input"
            type="url"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
            placeholder="https://example.com"
            autoComplete="off"
            spellCheck={false}
            required
            disabled={disabled}
          />
        </label>
        <div className="site-access-options">
          <label className="form-field" htmlFor="site-access-mode">
            <span>{t('siteAccessMode')}</span>
            <select
              id="site-access-mode"
              className="select"
              value={mode}
              disabled={disabled}
              aria-describedby="site-access-consequence"
              onChange={(event) => setMode(event.target.value as typeof mode)}
            >
              <option value="read-only">{t('siteAccessReadOnly')}</option>
              <option value="interactive">{t('siteAccessInteractive')}</option>
            </select>
          </label>
          <label className="form-field" htmlFor="site-access-duration">
            <span>{t('siteAccessDuration')}</span>
            <select
              id="site-access-duration"
              className="select"
              value={duration}
              disabled={disabled}
              onChange={(event) => setDuration(Number(event.target.value))}
            >
              <option value={15}>{t('siteAccess15Minutes')}</option>
              <option value={60}>{t('siteAccess1Hour')}</option>
              <option value={1440}>{t('siteAccess24Hours')}</option>
            </select>
          </label>
        </div>
        <p id="site-access-consequence" className="settings-hint">
          {t(mode === 'read-only' ? 'siteAccessReadOnlyHint' : 'siteAccessInteractiveHint')}
        </p>
        <button
          className="btn btn-primary save-button"
          type="submit"
          disabled={disabled || !origin.trim()}
        >
          {t('siteAccessGrant')}
        </button>
      </form>
      <details className="site-access-list">
        <summary>
          {t('siteAccessGrants')} <span className="site-access-count">({grants.length})</span>
        </summary>
        <div className="site-access-grants-body">
          {!grants.length && <p className="settings-hint">{t('siteAccessEmpty')}</p>}
          {grants.map((grant) => (
            <div key={grant.id} className="site-access-grant settings-row">
              <div className="settings-copy">
                <div className="site-access-origin">{grant.origin}</div>
                <p className="settings-hint">
                  {t(grant.mode === 'read-only' ? 'siteAccessReadOnly' : 'siteAccessInteractive')}
                  {' · '}
                  {grant.expiresAt <= now ? t('siteAccessExpired') : t('siteAccessExpires')}{' '}
                  <time dateTime={new Date(grant.expiresAt).toISOString()}>
                    {time(grant.expiresAt)}
                  </time>
                </p>
              </div>
              <button
                className="btn btn-ghost site-access-revoke"
                type="button"
                disabled={disabled}
                aria-label={t('siteAccessRevokeOrigin', { origin: grant.origin })}
                onClick={() => onChange?.({ type: 'remote-site-access-revoke', id: grant.id })}
              >
                {t('siteAccessRevoke')}
              </button>
            </div>
          ))}
        </div>
      </details>
      <details className="site-access-history">
        <summary>{t('siteAccessHistory')}</summary>
        <p className="settings-hint">{t('siteAccessHistoryScope')}</p>
        {!audit.length && <p className="settings-hint">{t('siteAccessNoHistory')}</p>}
        <ol>
          {audit
            .slice(-30)
            .reverse()
            .map((entry) => (
              <li key={entry.id} className="site-access-event">
                <div className="site-access-origin">{entry.origin}</div>
                <div className="settings-hint">
                  <span>{entry.action}</span>
                  {' · '}
                  <span>{t(entry.allowed ? 'siteAccessAllowed' : 'siteAccessDenied')}</span>
                  {entry.mode && (
                    <>
                      {' '}
                      ·{' '}
                      {t(
                        entry.mode === 'read-only' ? 'siteAccessReadOnly' : 'siteAccessInteractive',
                      )}
                    </>
                  )}
                </div>
                <time className="settings-hint" dateTime={new Date(entry.at).toISOString()}>
                  {time(entry.at)}
                </time>
              </li>
            ))}
        </ol>
      </details>
    </section>
  );
}
