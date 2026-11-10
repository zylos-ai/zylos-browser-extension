import { useEffect, useState } from 'react';
import type { RemoteRequest, RemoteState } from '../utils/remote';
import { useI18n } from './LanguageProvider';
import type { TranslationKey } from '../utils/i18n';
import './site-access.css';

const defaultLabels: Record<string, TranslationKey> = {
  billing: 'siteDefaultBilling',
  'payment-providers': 'siteDefaultPaymentProviders',
  banking: 'siteDefaultBanking',
  'account-security': 'siteDefaultAccountSecurity',
  'account-access': 'siteDefaultAccountAccess',
  'password-reset': 'siteDefaultPasswordReset',
  'security-settings': 'siteDefaultSecuritySettings',
  credentials: 'siteDefaultCredentials',
  'account-removal': 'siteDefaultAccountRemoval',
  banks: 'siteDefaultBanks',
  'financial-services': 'siteDefaultFinancialServices',
  'regional-finance': 'siteDefaultRegionalFinance',
  'custodial-services': 'siteDefaultCustodialServices',
  'exact-finance': 'siteDefaultExactFinance',
};

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
  const [matchType, setMatchType] = useState<'origin' | 'domain' | 'domain-regex'>('origin');
  const [mode, setMode] = useState<'denied' | 'read-only' | 'interactive'>('read-only');
  const [duration, setDuration] = useState('1');
  const [now, setNow] = useState(Date.now);
  const grants = state.siteAccess?.grants ?? [];
  const audit = state.siteAccess?.audit ?? [];
  const defaults = state.siteAccess?.defaults ?? [];
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const time = (at: number) => new Date(at).toLocaleString(locale);
  const disabled = pending || !onChange;
  const modeKey = (value: string): TranslationKey =>
    value === 'denied'
      ? 'siteAccessBlocked'
      : value === 'read-only'
        ? 'siteAccessReadOnly'
        : 'siteAccessInteractive';
  const matchKey = (value: string): TranslationKey =>
    value === 'domain'
      ? 'siteAccessDomain'
      : value === 'domain-regex'
        ? 'siteAccessDomainRegex'
        : 'siteAccessExactOrigin';
  return (
    <section
      className="settings-section site-access-settings"
      aria-labelledby="site-access-heading"
    >
      <h2 id="site-access-heading">{t('siteAccess')}</h2>
      {state.siteAccess?.recoveryRequired && (
        <div role="alert" className="site-access-recovery">
          <p>{t('siteAccessRecoveryRequired')}</p>
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled}
            onClick={() => onChange?.({ type: 'remote-site-access-reset' })}
          >
            {t('siteAccessReset')}
          </button>
        </div>
      )}
      <details className="site-access-add">
        <summary>{t('siteAccessAdd')}</summary>
        <div className="site-access-add-body">
          <p className="settings-hint">{t('siteAccessScope')}</p>
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled || !origin.trim()) return;
              onChange?.({
                type: 'remote-site-access-grant',
                origin: origin.trim(),
                matchType,
                mode,
                durationMinutes: duration === 'permanent' ? null : Number(duration) * 24 * 60,
              });
            }}
          >
            <label className="form-field" htmlFor="site-access-match-type">
              <span>{t('siteAccessMatchType')}</span>
              <select
                id="site-access-match-type"
                className="select"
                value={matchType}
                disabled={disabled}
                onChange={(event) => setMatchType(event.target.value as typeof matchType)}
                aria-describedby="site-access-match-hint"
              >
                <option value="origin">{t('siteAccessExactOrigin')}</option>
                <option value="domain">{t('siteAccessDomain')}</option>
                <option value="domain-regex">{t('siteAccessDomainRegex')}</option>
              </select>
            </label>
            <label className="form-field" htmlFor="site-access-origin">
              <span>{t(matchType === 'origin' ? 'siteAccessOrigin' : 'siteAccessPattern')}</span>
              <input
                id="site-access-origin"
                className="input"
                type="text"
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
                placeholder={
                  matchType === 'origin'
                    ? 'https://example.com'
                    : matchType === 'domain'
                      ? '*.example.com'
                      : '^.*\\.example\\.com$'
                }
                aria-describedby="site-access-match-hint"
                autoComplete="off"
                spellCheck={false}
                required
                disabled={disabled}
              />
            </label>
            <p id="site-access-match-hint" className="settings-hint">
              {t(
                matchType === 'origin'
                  ? 'siteAccessOriginHint'
                  : matchType === 'domain'
                    ? 'siteAccessDomainHint'
                    : 'siteAccessRegexHint',
              )}
            </p>
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
                  <option value="denied">{t('siteAccessBlocked')}</option>
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
                  onChange={(event) => setDuration(event.target.value)}
                >
                  <option value="1">{t('siteAccess1Day')}</option>
                  <option value="7">{t('siteAccess7Days')}</option>
                  <option value="30">{t('siteAccess30Days')}</option>
                  <option value="permanent">{t('siteAccessPermanent')}</option>
                </select>
              </label>
            </div>
            <p id="site-access-consequence" className="settings-hint">
              {t(
                mode === 'denied'
                  ? 'siteAccessBlockedHint'
                  : mode === 'read-only'
                    ? 'siteAccessReadOnlyHint'
                    : 'siteAccessInteractiveHint',
              )}
            </p>
            <button
              className="btn btn-primary save-button"
              type="submit"
              disabled={disabled || !origin.trim()}
            >
              {t('siteAccessGrant')}
            </button>
          </form>
        </div>
      </details>
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
                  {t(matchKey(grant.matchType ?? 'origin'))}
                  {' · '}
                  {t(modeKey(grant.mode))}
                  {' · '}
                  {grant.expiresAt === null ? (
                    t('siteAccessPermanent')
                  ) : (
                    <>
                      {grant.expiresAt <= now ? t('siteAccessExpired') : t('siteAccessExpires')}{' '}
                      <time dateTime={new Date(grant.expiresAt).toISOString()}>
                        {time(grant.expiresAt)}
                      </time>
                    </>
                  )}
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
      <details className="site-access-defaults">
        <summary>
          {t('siteAccessDefaults')} <span className="site-access-count">({defaults.length})</span>
        </summary>
        <p className="settings-hint">{t('siteAccessDefaultsHint')}</p>
        <div className="site-access-defaults-body">
          {defaults.map((rule) => {
            const label = defaultLabels[rule.id] ? t(defaultLabels[rule.id]!) : rule.label;
            return (
              <div className="site-access-default" key={rule.id}>
                <label className="site-access-default-toggle">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    disabled={disabled}
                    onChange={(event) =>
                      onChange?.({
                        type: 'remote-site-access-default',
                        id: rule.id,
                        enabled: event.target.checked,
                        mode: rule.mode,
                      })
                    }
                  />
                  <span>{label}</span>
                </label>
                <details className="site-default-pattern">
                  <summary>{t('siteAccessPatternDetails')}</summary>
                  <code className="site-access-pattern">{rule.pattern}</code>
                </details>
                <label className="form-field">
                  <span className="site-access-default-mode-label">{t('siteAccessMode')}</span>
                  <select
                    className="select"
                    value={rule.mode}
                    disabled={disabled}
                    aria-label={t('siteAccessDefaultMode', { rule: label })}
                    onChange={(event) =>
                      onChange?.({
                        type: 'remote-site-access-default',
                        id: rule.id,
                        enabled: rule.enabled,
                        mode: event.target.value as 'denied' | 'read-only' | 'interactive',
                      })
                    }
                  >
                    <option value="denied">{t('siteAccessBlocked')}</option>
                    <option value="read-only">{t('siteAccessReadOnly')}</option>
                    <option value="interactive">{t('siteAccessInteractive')}</option>
                  </select>
                </label>
              </div>
            );
          })}
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
                  {entry.mode && <> · {t(modeKey(entry.mode))}</>}
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
