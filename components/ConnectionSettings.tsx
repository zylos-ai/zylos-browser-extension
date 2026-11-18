import { useI18n } from './LanguageProvider';
import { languagePreference } from '../utils/i18n';
import type { RemoteRequest, RemoteState } from '../utils/remote';
import { DetailedDiagnosticsSettings } from './DetailedDiagnosticsSettings';
import { SiteAccessSettings } from './SiteAccessSettings';
import { AgentStartSettings } from './AgentStartSettings';
import { AgentAvatar, connectionAvatar } from './WorkspaceConnect';

export function ConnectionSettings({
  state,
  pending,
  onToggle,
  onDiagnosticsToggle,
  onDetailedToggle,
  onAgentStartToggle,
  onCompatibilityToggle,
  onSiteAccessChange,
  status,
  onOpenConnect,
}: {
  state: RemoteState;
  pending: boolean;
  onToggle: () => void;
  onDiagnosticsToggle?: () => void;
  onDetailedToggle?: () => void;
  onAgentStartToggle?: (enabled: boolean, durationMinutes?: number | null) => void;
  onCompatibilityToggle?: () => void;
  onSiteAccessChange?: (request: RemoteRequest) => void;
  status: string;
  onOpenConnect: () => void;
}) {
  const { t, preference, changeLanguage, savingLanguage, languageError } = useI18n();
  const connection = state.workspace?.connection;
  return (
    <main id="settings" className="settings-page" aria-labelledby="settings-title">
      <div className="settings-intro">
        <h1 id="settings-title">{t('settings')}</h1>
      </div>
      <section className="settings-section connection-summary" aria-labelledby="connection-heading">
        <h2 id="connection-heading">{t('connectionSectionTitle')}</h2>
        <div className="connection-summary-row">
          {connection ? (
            <AgentAvatar name={connection.agentName} url={connectionAvatar(state.workspace)} />
          ) : (
            <span
              className={`status-dot${state.connected ? ' is-connected' : ''}`}
              aria-hidden="true"
            />
          )}
          <span className="connection-summary-text">
            {connection?.agentName ||
              (state.configured ? state.relayHost || t('manualConnectTitle') : t('notConnected'))}
            {state.configured && (
              <small className={state.connected ? 'is-connected' : ''}>{status}</small>
            )}
          </span>
          <button
            className="btn btn-outline btn-sm connection-manage"
            type="button"
            onClick={onOpenConnect}
          >
            {state.configured ? t('manageConnection') : t('connectAction')}
          </button>
        </div>
      </section>
      <SiteAccessSettings state={state} pending={pending} onChange={onSiteAccessChange} />
      <DetailedDiagnosticsSettings
        state={state}
        pending={pending}
        onToggle={() => onDetailedToggle?.()}
      />
      <section
        className="settings-section preferences-settings"
        aria-labelledby="preferences-heading"
      >
        <h2 id="preferences-heading">{t('preferences')}</h2>
        <div className="settings-row">
          <div className="settings-copy">
            <label id="compatibility-label" htmlFor="compatibility-enabled">
              {t('taskCompatibilityPermission')}
            </label>
            <p id="compatibility-hint" className="settings-hint">
              {t('compatibilityHint')}
            </p>
          </div>
          <button
            id="compatibility-enabled"
            className="connection-toggle"
            type="button"
            role="switch"
            aria-checked={!!state.compatibilityEnabled}
            aria-labelledby="compatibility-label"
            aria-describedby="compatibility-hint"
            disabled={pending}
            onClick={onCompatibilityToggle}
          >
            <span className="settings-switch-track" aria-hidden="true">
              <span />
            </span>
          </button>
        </div>
        <AgentStartSettings state={state} pending={pending} onChange={onAgentStartToggle} />
        <div className="settings-row">
          <div className="settings-copy">
            <label id="diagnostics-label" htmlFor="diagnostics-enabled">
              {t('diagnostics')}
            </label>
            <p id="diagnostics-hint" className="settings-hint">
              {t('diagnosticsHint')}
            </p>
          </div>
          <button
            id="diagnostics-enabled"
            className="connection-toggle"
            type="button"
            role="switch"
            aria-checked={!!state.diagnosticsEnabled}
            aria-labelledby="diagnostics-label"
            aria-describedby="diagnostics-hint"
            disabled={pending}
            onClick={onDiagnosticsToggle}
          >
            <span className="settings-switch-track" aria-hidden="true">
              <span />
            </span>
          </button>
        </div>
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
