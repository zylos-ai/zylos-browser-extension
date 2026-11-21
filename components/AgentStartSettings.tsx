import { useState } from 'react';
import type { RemoteState } from '../utils/remote';
import { AGENT_START_DURATION_DAYS } from '../utils/agent-start-grant';
import type { TranslationKey } from '../utils/i18n';
import { useI18n } from './LanguageProvider';
import { SettingsItem, Switch } from './SettingsList';
import './site-access.css';

const durationLabels: Record<(typeof AGENT_START_DURATION_DAYS)[number], TranslationKey> = {
  1: 'siteAccess1Day',
  7: 'siteAccess7Days',
  30: 'siteAccess30Days',
};

/** Agent-start consent with the same 1/7/30-day or permanent validity as site rules. */
export function AgentStartSettings({
  state,
  pending,
  onChange,
}: {
  state: RemoteState;
  pending: boolean;
  onChange?: (enabled: boolean, durationMinutes?: number | null) => void;
}) {
  const { t, locale } = useI18n();
  const [duration, setDuration] = useState('7');
  const enabled = !!state.agentStartEnabled;
  const disabled = pending || !onChange || (!state.connected && !enabled);
  const expiresAt = state.agentStartExpiresAt;
  return (
    <>
      <SettingsItem
        className="agent-start-settings"
        label={t('agentStartPermission')}
        labelId="agent-start-label"
        htmlFor="agent-start-enabled"
        hint={t('agentStartShort')}
        hintId="agent-start-hint"
        more={t('agentStartPermissionHint')}
        control={
          <Switch
            id="agent-start-enabled"
            checked={enabled}
            labelledBy="agent-start-label"
            describedBy="agent-start-hint"
            disabled={disabled}
            onClick={() =>
              enabled
                ? onChange?.(false)
                : onChange?.(true, duration === 'permanent' ? null : Number(duration) * 24 * 60)
            }
          />
        }
      />
      {enabled ? (
        <div className="settings-item settings-sub agent-start-status">
          <div className="settings-item-main">
            <p id="agent-start-expiry" className="settings-item-hint" role="status">
              {expiresAt === null || expiresAt === undefined ? (
                t('agentStartAllowedUntilOff')
              ) : (
                <time dateTime={new Date(expiresAt).toISOString()}>
                  {t('agentStartAllowedUntil', {
                    time: new Date(expiresAt).toLocaleString(locale),
                  })}
                </time>
              )}
            </p>
            <button
              className="link-button site-access-revoke"
              type="button"
              disabled={pending || !onChange}
              aria-describedby="agent-start-expiry"
              onClick={() => onChange?.(false)}
            >
              {t('siteAccessRevoke')}
            </button>
          </div>
        </div>
      ) : (
        <SettingsItem
          className="settings-sub agent-start-duration"
          label={t('siteAccessDuration')}
          htmlFor="agent-start-duration"
          control={
            <select
              id="agent-start-duration"
              className="select settings-select"
              value={duration}
              disabled={disabled}
              onChange={(event) => setDuration(event.target.value)}
            >
              {AGENT_START_DURATION_DAYS.map((days) => (
                <option key={days} value={String(days)}>
                  {t(durationLabels[days])}
                </option>
              ))}
              <option value="permanent">{t('agentStartUntilOff')}</option>
            </select>
          }
        />
      )}
    </>
  );
}
