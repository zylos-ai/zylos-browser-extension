import { useState } from 'react';
import type { RemoteState } from '../utils/remote';
import { AGENT_START_DURATION_DAYS } from '../utils/agent-start-grant';
import type { TranslationKey } from '../utils/i18n';
import { useI18n } from './LanguageProvider';
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
    <div className="agent-start-settings">
      <div className="settings-row">
        <div className="settings-copy">
          <label id="agent-start-label" htmlFor="agent-start-enabled">
            {t('agentStartPermission')}
          </label>
          <p id="agent-start-hint" className="settings-hint">
            {t('agentStartPermissionHint')}
          </p>
        </div>
        <button
          id="agent-start-enabled"
          className="connection-toggle"
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="agent-start-label"
          aria-describedby="agent-start-hint"
          disabled={disabled}
          onClick={() =>
            enabled
              ? onChange?.(false)
              : onChange?.(true, duration === 'permanent' ? null : Number(duration) * 24 * 60)
          }
        >
          <span className="settings-switch-track" aria-hidden="true">
            <span />
          </span>
        </button>
      </div>
      {enabled ? (
        <div className="settings-row agent-start-status">
          <p id="agent-start-expiry" className="settings-hint" role="status">
            {expiresAt === null || expiresAt === undefined ? (
              t('agentStartAllowedUntilOff')
            ) : (
              <time dateTime={new Date(expiresAt).toISOString()}>
                {t('agentStartAllowedUntil', { time: new Date(expiresAt).toLocaleString(locale) })}
              </time>
            )}
          </p>
          <button
            className="btn btn-ghost site-access-revoke"
            type="button"
            disabled={pending || !onChange}
            aria-describedby="agent-start-expiry"
            onClick={() => onChange?.(false)}
          >
            {t('siteAccessRevoke')}
          </button>
        </div>
      ) : (
        <label className="form-field agent-start-duration" htmlFor="agent-start-duration">
          <span>{t('siteAccessDuration')}</span>
          <select
            id="agent-start-duration"
            className="select"
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
        </label>
      )}
    </div>
  );
}
