import { useEffect, useRef, useState } from 'react';
import type { RemoteState } from '../utils/remote';
import { useI18n } from './LanguageProvider';

export function DetailedDiagnosticsSettings({
  state,
  pending,
  onToggle,
}: {
  state: RemoteState;
  pending: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const details = state.detailedDiagnostics;
  const token = details?.enabled ? details.consent : '';
  const current = useRef(token);
  current.current = token;
  const mounted = useRef(true);
  const [preview, setPreview] = useState<{ token: string; text: string; hash: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [share, setShare] = useState<{
    id: string;
    text: string;
    sha256: string;
    recipient: string;
    expiresAt: number;
  }>();
  const [accepted, setAccepted] = useState(false);
  const shareScope = `${token}:${state.connected}:${state.relayUrl}`;
  const currentShareScope = useRef(shareScope);
  currentShareScope.current = shareScope;
  const shareRequest = useRef(0);
  const phase = state.detailedSharing?.phase;
  const authorized = phase === 'authorized';
  useEffect(() => {
    if (phase === 'consumed' || phase === 'expired' || phase === 'revoked') {
      setShare(undefined);
      setAccepted(false);
    }
  }, [phase]);
  useEffect(() => {
    setPreview(undefined);
    setError(false);
    setShare(undefined);
    setAccepted(false);
  }, [token]);
  useEffect(() => {
    shareRequest.current++;
    setShare(undefined);
    setAccepted(false);
  }, [state.connected, state.relayUrl]);
  useEffect(() => {
    if (!share) return;
    const timer = setTimeout(
      () => {
        shareRequest.current++;
        setShare(undefined);
        setAccepted(false);
      },
      Math.max(0, share.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [share]);
  const shareAction = async (type: 'prepare' | 'grant' | 'revoke') => {
    const request = ++shareRequest.current;
    const stillCurrent = () =>
      valid() && shareScope === currentShareScope.current && request === shareRequest.current;
    setBusy(true);
    setError(false);
    try {
      const reply = await chrome.runtime.sendMessage(
        type === 'prepare'
          ? { type: 'remote-detail-share-prepare', consent: token }
          : type === 'grant'
            ? { type: 'remote-detail-share-grant', id: share?.id }
            : { type: 'remote-detail-share-revoke' },
      );
      if (!stillCurrent()) return;
      if (!reply?.ok) throw new Error('Unavailable');
      if (type === 'prepare') {
        setShare(reply.value);
        setAccepted(false);
      } else if (type === 'revoke') {
        setShare(undefined);
        setAccepted(false);
      }
    } catch {
      if (stillCurrent()) setError(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const valid = () =>
    mounted.current &&
    !!token &&
    current.current === token &&
    Date.now() < (details?.expiresAt ?? 0);
  const load = async () => {
    if (!valid()) return;
    setBusy(true);
    setError(false);
    try {
      const reply = await chrome.runtime.sendMessage({
        type: 'remote-detailed-preview',
        consent: token,
      });
      if (!reply?.ok) throw new Error('Unavailable');
      const text = JSON.stringify(reply.value, null, 2);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      const hash = Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join(
        '',
      );
      if (valid()) setPreview({ token, text, hash });
    } catch {
      if (valid()) setError(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const download = async () => {
    if (!preview || preview.token !== token || !valid()) return;
    setBusy(true);
    try {
      const reply = await chrome.runtime.sendMessage({
        type: 'remote-detailed-validate',
        consent: token,
      });
      if (!reply?.ok || !reply.value?.valid || !valid()) {
        setPreview(undefined);
        return;
      }
      const url = URL.createObjectURL(new Blob([preview.text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `zylos-diagnostics-${preview.hash.slice(0, 12)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      if (valid()) setError(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section className="settings-section" aria-labelledby="detailed-heading">
      <div className="settings-row">
        <div className="settings-copy">
          <h2 id="detailed-heading">{t('detailedDiagnostics')}</h2>
          <p id="detailed-hint" className="settings-hint">
            {t('detailedDiagnosticsHint')}
          </p>
        </div>
        <button
          id="detailed-enabled"
          type="button"
          role="switch"
          className="connection-toggle"
          aria-checked={!!token}
          aria-labelledby="detailed-heading"
          aria-describedby="detailed-hint"
          disabled={pending}
          onClick={() => {
            setPreview(undefined);
            onToggle();
          }}
        >
          <span className="settings-switch-track" aria-hidden="true">
            <span />
          </span>
        </button>
      </div>
      {!!token && (
        <>
          <p className="settings-hint">
            {t('detailedExpires')} {new Date(details!.expiresAt).toLocaleTimeString()}
          </p>
          <button
            id="detailed-preview"
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void load()}
          >
            {t('detailedPreview')}
          </button>
          <button
            id="detail-share-prepare"
            type="button"
            className="btn"
            disabled={busy || !state.connected || !state.relayUrl.startsWith('wss:')}
            onClick={() => void shareAction('prepare')}
          >
            {t('detailSharePreview')}
          </button>
        </>
      )}
      {preview?.token === token && !!token && (
        <>
          <p className="settings-hint">{t('detailedReviewWarning')}</p>
          <textarea
            id="detailed-preview-text"
            className="input detailed-preview"
            aria-label={t('detailedPreview')}
            readOnly
            value={preview.text}
            rows={12}
          />
          <p className="settings-hint detailed-hash">SHA-256: {preview.hash}</p>
          <button
            id="detailed-download"
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void download()}
          >
            {t('detailedDownload')}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="settings-hint">
          {t('detailedExpired')}
        </p>
      )}
      {share && !!token && (
        <>
          <p className="settings-hint">
            {t('detailShareRecipient')} {share.recipient}
          </p>
          <p className="settings-hint">{t('detailShareDisclosure')}</p>
          <textarea
            id="detail-share-text"
            className="input detailed-preview"
            aria-label={t('detailSharePreview')}
            readOnly
            rows={12}
            value={share.text}
          />
          <p className="settings-hint detailed-hash">SHA-256: {share.sha256}</p>
          <p className="settings-hint">
            {t('detailShareExpires')} {new Date(share.expiresAt).toLocaleTimeString()}
          </p>
          {!authorized && (
            <label>
              <input
                id="detail-share-consent"
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              {t('detailShareConsent')}
            </label>
          )}
          {!authorized && (
            <button
              id="detail-share-grant"
              type="button"
              className="btn"
              disabled={busy || !accepted || Date.now() >= share.expiresAt}
              onClick={() => void shareAction('grant')}
            >
              {t('detailShareAuthorize')}
            </button>
          )}
        </>
      )}
      {authorized && (
        <p role="status" className="settings-hint">
          {t('detailShareAuthorized')}{' '}
          {new Date(state.detailedSharing!.expiresAt).toLocaleTimeString()}
        </p>
      )}
      {(phase === 'prepared' || authorized) && (
        <button
          id="detail-share-revoke"
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void shareAction('revoke')}
        >
          {t('detailShareRevoke')}
        </button>
      )}
      {phase === 'consumed' && (
        <p role="status" className="settings-hint">
          {t('detailShareConsumed')}
        </p>
      )}
      {phase === 'expired' && (
        <p role="status" className="settings-hint">
          {t('detailShareExpired')}
        </p>
      )}
      {phase === 'revoked' && !!token && (
        <p role="status" className="settings-hint">
          {t('detailShareRevoked')}
        </p>
      )}
    </section>
  );
}
