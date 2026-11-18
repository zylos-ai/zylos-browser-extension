import { useEffect, useState } from 'react';
import { useI18n } from './LanguageProvider';
import type { RemoteRequest, RemoteState } from '../utils/remote';
import { defaultBrowserName } from '../utils/workspace/config';
import type { WorkspaceView } from '../utils/workspace/connector';

type Agent = NonNullable<WorkspaceView['agents']>[number];
type Step =
  | { kind: 'list' }
  | { kind: 'confirm'; agent: Agent }
  | { kind: 'name'; agent: Agent; confirm: boolean };

/**
 * OpenMax Workspace mode: sign in, pick an Agent, name this browser, connect.
 * The manual relay URL + Key form below stays available as an alternative.
 */
export function WorkspaceConnect({
  state,
  pending,
  onRequest,
}: {
  state: RemoteState;
  pending: boolean;
  onRequest: (request: RemoteRequest) => void;
}) {
  const { t, errorText } = useI18n();
  const ws = state.workspace;
  const [step, setStep] = useState<Step>({ kind: 'list' });
  const [choosing, setChoosing] = useState(false);
  const [browserName, setBrowserName] = useState(defaultBrowserName());
  const [url, setUrl] = useState(ws?.baseUrl ?? '');
  const connection = ws?.connection;
  const signedIn = ws?.auth === 'signed-in';
  const showPicker = signedIn && (!connection || choosing);

  useEffect(() => {
    if (showPicker && !ws?.agents && !ws?.busy) onRequest({ type: 'workspace-agents' });
    // Load once per entry into the picker.
  }, [showPicker]);
  useEffect(() => {
    if (connection?.phase === 'preparing') {
      setChoosing(false);
      setStep({ kind: 'list' });
    }
  }, [connection?.phase]);
  if (!ws) return null;

  const busy = pending || !!ws.busy;
  const settling = connection?.phase === 'preparing' || connection?.phase === 'applying';
  const phaseText = connection
    ? {
        idle: t('workspacePhasePreparing'),
        preparing: t('workspacePhasePreparing'),
        applying: t('workspacePhasePreparing'),
        connected: state.connected ? t('connected') : t('connecting'),
        failed: t('workspacePhaseFailed'),
        'key-rejected': t('workspacePhaseKeyRejected'),
      }[connection.phase]
    : '';
  // Switching never offers the Agent this browser is already connected to.
  const agents = ws.agents?.filter((agent) => agent.id !== connection?.agentMemberId);
  const needsConfirm = agents?.some((agent) => !agent.authorized);
  const error = ws.error && (
    <p className="settings-hint workspace-error" role="alert">
      {errorText(ws.error)}
    </p>
  );

  return (
    <section className="settings-section workspace-settings" aria-labelledby="workspace-heading">
      <h2 id="workspace-heading">{t('workspaceTitle')}</h2>
      {!connection && <p className="settings-hint">{t('workspaceHint')}</p>}

      {!ws.baseUrl ? (
        <WorkspaceUrlForm url={url} setUrl={setUrl} busy={busy} onRequest={onRequest} />
      ) : ws.auth !== 'signed-in' ? (
        <>
          {ws.auth === 'expired' && (
            <p className="settings-hint" role="status">
              {t('workspaceLoginExpired')}
            </p>
          )}
          <button
            className="btn btn-primary save-button"
            type="button"
            disabled={busy}
            onClick={() => onRequest({ type: 'workspace-sign-in' })}
          >
            {busy
              ? t('workspaceSigningIn')
              : ws.auth === 'expired'
                ? t('workspaceLoginAgain')
                : t('workspaceLogin')}
          </button>
          {error}
        </>
      ) : null}

      {connection && (
        <div className="workspace-card" aria-live="polite">
          <div className="settings-copy">
            <strong>{connection.agentName || t('workspaceAgent')}</strong>
            <p className="settings-hint">
              <span
                className={`workspace-phase is-${connection.phase === 'connected' && state.connected ? 'connected' : connection.phase}`}
              >
                {phaseText}
              </span>
              {' · '}
              {connection.browserName}
            </p>
            {connection.error && (
              <p className="settings-hint workspace-error" role="alert">
                {errorText(connection.error)}
              </p>
            )}
            {!signedIn &&
              (connection.phase === 'key-rejected' || connection.phase === 'failed') && (
                <p className="settings-hint">{t('workspaceReconnectNeedsLogin')}</p>
              )}
          </div>
          <div className="workspace-actions">
            {signedIn && (connection.phase === 'key-rejected' || connection.phase === 'failed') && (
              <button
                className="btn btn-primary btn-sm"
                type="button"
                disabled={busy}
                onClick={() => onRequest({ type: 'workspace-reconnect' })}
              >
                {t('workspaceReconnect')}
              </button>
            )}
            {signedIn && !settling && (
              <button
                className="btn btn-sm"
                type="button"
                disabled={busy}
                aria-expanded={choosing}
                onClick={() => {
                  setChoosing((v) => !v);
                  setStep({ kind: 'list' });
                }}
              >
                {choosing ? t('workspaceCollapse') : t('workspaceSwitchAgent')}
              </button>
            )}
            <button
              className="btn btn-sm btn-ghost workspace-revoke"
              type="button"
              disabled={busy || settling}
              onClick={() => {
                if (window.confirm(t('workspaceRevokeConfirm', { agent: connection.agentName })))
                  onRequest({ type: 'workspace-revoke' });
              }}
            >
              {t('workspaceRevoke')}
            </button>
          </div>
        </div>
      )}

      {signedIn && !connection && (
        <p className="settings-hint" role="status">
          {t('workspaceNotConnectedHint')}
        </p>
      )}

      {showPicker && step.kind === 'list' && (
        <div className="workspace-agents" role="list" aria-label={t('workspaceChooseAgent')}>
          <strong>{t('workspaceChooseAgent')}</strong>
          {needsConfirm && <p className="settings-hint">{t('workspaceNeedsConfirmHint')}</p>}
          {ws.busy === 'agents' && <p className="settings-hint">{t('workspaceLoadingAgents')}</p>}
          {agents?.length === 0 && (
            <p className="settings-hint">
              {connection ? t('workspaceNoOtherAgents') : t('workspaceNoAgents')}
            </p>
          )}
          {agents?.map((agent) => (
            <button
              key={agent.id}
              role="listitem"
              className="btn workspace-agent"
              type="button"
              disabled={busy}
              onClick={() =>
                setStep(
                  agent.authorized
                    ? { kind: 'name', agent, confirm: false }
                    : { kind: 'confirm', agent },
                )
              }
            >
              <span>{agent.name}</span>
              <span className="settings-hint">
                {agent.authorized ? t('workspaceAuthorized') : t('workspaceNeedsConfirm')}
              </span>
            </button>
          ))}
          {error}
          {ws.error && !ws.busy && (
            <button
              className="btn btn-sm"
              type="button"
              disabled={busy}
              onClick={() => onRequest({ type: 'workspace-agents' })}
            >
              {t('workspaceRetry')}
            </button>
          )}
        </div>
      )}

      {showPicker && step.kind === 'confirm' && (
        <div className="workspace-card workspace-confirm">
          <strong>{t('workspaceConfirmTitle', { agent: step.agent.name })}</strong>
          <ul className="settings-hint">
            <li>{t('workspaceCapabilityRead')}</li>
            <li>{t('workspaceCapabilityAct')}</li>
            <li>{t('workspaceCapabilityLocal')}</li>
          </ul>
          <div className="workspace-actions">
            <button
              className="btn btn-primary btn-sm"
              type="button"
              onClick={() => setStep({ kind: 'name', agent: step.agent, confirm: true })}
            >
              {t('workspaceAllow')}
            </button>
            <button className="btn btn-sm" type="button" onClick={() => setStep({ kind: 'list' })}>
              {t('cancel')}
            </button>
          </div>
        </div>
      )}

      {showPicker && step.kind === 'name' && (
        <form
          className="settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!browserName.trim()) return;
            onRequest({
              type: 'workspace-connect',
              agentMemberId: step.agent.id,
              agentName: step.agent.name,
              browserName: browserName.trim(),
              confirm: step.confirm,
            });
          }}
        >
          <label className="form-field" htmlFor="workspace-browser-name">
            <span>{t('workspaceBrowserName')}</span>
            <input
              className="input"
              id="workspace-browser-name"
              value={browserName}
              maxLength={100}
              onChange={(e) => setBrowserName(e.target.value)}
              required
              disabled={busy}
            />
            <span className="settings-hint">
              {t('workspaceBrowserNameHint', { agent: step.agent.name })}
            </span>
          </label>
          {connection?.phase === 'connected' && (
            <p className="settings-hint">{t('workspaceSwitchHint')}</p>
          )}
          <button
            className="btn btn-primary save-button"
            type="submit"
            disabled={busy || !browserName.trim()}
          >
            {t('workspaceConnect')}
          </button>
          <button className="btn btn-sm" type="button" onClick={() => setStep({ kind: 'list' })}>
            {t('back')}
          </button>
        </form>
      )}

      {signedIn && !(showPicker && step.kind === 'list') && error}

      {ws.baseUrl && (
        <details className="workspace-advanced">
          <summary className="settings-hint">{t('workspaceAddress')}</summary>
          <WorkspaceUrlForm url={url} setUrl={setUrl} busy={busy} onRequest={onRequest} />
          {signedIn && (
            <button
              className="btn btn-sm"
              type="button"
              disabled={busy}
              onClick={() => onRequest({ type: 'workspace-sign-out' })}
            >
              {t('workspaceLogout')}
            </button>
          )}
        </details>
      )}
    </section>
  );
}

function WorkspaceUrlForm({
  url,
  setUrl,
  busy,
  onRequest,
}: {
  url: string;
  setUrl: (value: string) => void;
  busy: boolean;
  onRequest: (request: RemoteRequest) => void;
}) {
  const { t } = useI18n();
  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        onRequest({ type: 'workspace-set-url', url });
      }}
    >
      <label className="form-field" htmlFor="workspace-url">
        <span>{t('workspaceAddress')}</span>
        <input
          className="input"
          id="workspace-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
        <span className="settings-hint">{t('workspaceAddressHint')}</span>
      </label>
      <button className="btn btn-sm" type="submit" disabled={busy || !url.trim()}>
        {t('saveSettings')}
      </button>
    </form>
  );
}
