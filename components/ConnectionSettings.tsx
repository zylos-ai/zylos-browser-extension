import { useState } from 'react';
import { SettingsGroup, SettingsItem, SettingsLink, Switch } from './SettingsList';
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
  const [page, setPage] = useState<'main' | 'site-access' | 'detailed'>('main');
  const connection = state.workspace?.connection;
  const ruleCount = state.siteAccess?.grants?.length ?? 0;

  if (page !== 'main')
    return (
      <main
        id="settings"
        className="settings-page settings-subpage"
        aria-labelledby="settings-title"
      >
        <button className="link-button settings-back" type="button" onClick={() => setPage('main')}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m15 6-6 6 6 6" />
          </svg>
          {t('settings')}
        </button>
        <h1 id="settings-title">
          {page === 'site-access' ? t('siteAccess') : t('detailedDiagnostics')}
        </h1>
        {page === 'site-access' ? (
          <SiteAccessSettings state={state} pending={pending} onChange={onSiteAccessChange} />
        ) : (
          <DetailedDiagnosticsSettings
            state={state}
            pending={pending}
            onToggle={() => onDetailedToggle?.()}
          />
        )}
      </main>
    );

  return (
    <main id="settings" className="settings-page" aria-labelledby="settings-title">
      <h1 id="settings-title" className="settings-title">
        {t('settings')}
      </h1>
      <SettingsGroup
        id="connection-heading"
        title={t('connectionSectionTitle')}
        className="connection-summary"
      >
        <SettingsLink
          className="connection-manage"
          leading={
            connection ? (
              <AgentAvatar name={connection.agentName} url={connectionAvatar(state.workspace)} />
            ) : (
              <span className={`settings-status-icon${state.connected ? ' is-connected' : ''}`}>
                <span className="status-dot" />
              </span>
            )
          }
          label={
            connection?.agentName ||
            (state.configured ? state.relayHost || t('manualConnectTitle') : t('notConnected'))
          }
          hint={
            state.configured ? (
              <span className={state.connected ? 'is-connected' : ''}>{status}</span>
            ) : (
              t('connectAction')
            )
          }
          onClick={onOpenConnect}
        />
      </SettingsGroup>
      <SettingsGroup id="site-access-group" title={t('siteAccess')}>
        <SettingsLink
          className="site-access-link"
          label={t('siteAccessGrants')}
          hint={state.siteAccess?.recoveryRequired ? t('siteAccessNeedsAttention') : undefined}
          value={ruleCount}
          onClick={() => setPage('site-access')}
        />
      </SettingsGroup>
      <SettingsGroup
        id="preferences-heading"
        title={t('preferences')}
        className="preferences-settings"
      >
        <AgentStartSettings state={state} pending={pending} onChange={onAgentStartToggle} />
        <SettingsItem
          label={t('taskCompatibilityPermission')}
          labelId="compatibility-label"
          htmlFor="compatibility-enabled"
          hint={t('compatibilityShort')}
          hintId="compatibility-hint"
          more={t('compatibilityHint')}
          control={
            <Switch
              id="compatibility-enabled"
              checked={!!state.compatibilityEnabled}
              labelledBy="compatibility-label"
              describedBy="compatibility-hint"
              disabled={pending}
              onClick={onCompatibilityToggle}
            />
          }
        />
        <SettingsItem
          className="language-settings"
          label={t('language')}
          htmlFor="interface-language"
          hint={
            languageError ? (
              <span role="alert" className="language-error">
                {t('languageSaveFailed')}
              </span>
            ) : undefined
          }
          control={
            <select
              id="interface-language"
              className="select settings-select"
              value={preference}
              disabled={savingLanguage}
              onChange={(e) => void changeLanguage(languagePreference(e.target.value))}
            >
              <option value="auto">{t('autoLanguage')}</option>
              <option value="zh-CN">中文</option>
              <option value="en">English</option>
            </select>
          }
        />
      </SettingsGroup>
      <SettingsGroup id="advanced-heading" title={t('advanced')}>
        <SettingsItem
          label={t('diagnostics')}
          labelId="diagnostics-label"
          htmlFor="diagnostics-enabled"
          hint={t('diagnosticsShort')}
          hintId="diagnostics-hint"
          more={t('diagnosticsHint')}
          control={
            <Switch
              id="diagnostics-enabled"
              checked={!!state.diagnosticsEnabled}
              labelledBy="diagnostics-label"
              describedBy="diagnostics-hint"
              disabled={pending}
              onClick={onDiagnosticsToggle}
            />
          }
        />
        <SettingsLink
          className="detailed-link"
          label={t('detailedDiagnostics')}
          value={state.detailedDiagnostics?.enabled ? t('on') : t('off')}
          onClick={() => setPage('detailed')}
        />
        {state.configured && (
          <SettingsItem
            className="connection-management"
            label={t('connectionEnabled')}
            labelId="connection-enabled-label"
            htmlFor="connection-enabled"
            hint={t('connectionEnabledHint')}
            hintId="connection-enabled-hint"
            control={
              <Switch
                id="connection-enabled"
                checked={state.enabled}
                labelledBy="connection-enabled-label"
                describedBy="connection-enabled-hint"
                disabled={pending}
                onClick={onToggle}
              />
            }
          />
        )}
      </SettingsGroup>
    </main>
  );
}
