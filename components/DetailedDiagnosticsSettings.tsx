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
  const [preview, setPreview] = useState<{
    token: string;
    text: string;
    hash: string;
    count: number;
  }>();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const localRequest = useRef(0);
  const [localBusy, setLocalBusy] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const busy = localBusy || shareBusy;
  const [error, setError] = useState(false);
  const [share, setShare] = useState<{
    id: string;
    text: string;
    sha256: string;
    recipient: string;
    expiresAt: number;
    count?: number;
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
      setShareOpen(false);
    }
  }, [phase]);
  useEffect(() => {
    setPreview(undefined);
    setPreviewOpen(false);
    setShareOpen(false);
    localRequest.current++;
    shareRequest.current++;
    setLocalBusy(false);
    setShareBusy(false);
    setError(false);
    setShare(undefined);
    setAccepted(false);
  }, [token]);
  useEffect(() => {
    shareRequest.current++;
    setShareBusy(false);
    setShare(undefined);
    setAccepted(false);
    setShareOpen(false);
  }, [state.connected, state.relayUrl]);
  useEffect(() => {
    if (!share) return;
    const timer = setTimeout(
      () => {
        shareRequest.current++;
        setShareBusy(false);
        setShare(undefined);
        setAccepted(false);
        setShareOpen(false);
      },
      Math.max(0, share.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [share]);
  const shareAction = async (type: 'prepare' | 'grant' | 'revoke') => {
    const request = ++shareRequest.current;
    const stillCurrent = () =>
      valid() && shareScope === currentShareScope.current && request === shareRequest.current;
    setShareBusy(true);
    setError(false);
    if (type === 'prepare') {
      setAccepted(false);
      setShareOpen(false);
    }
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
        let count: number | undefined;
        try {
          const snapshot = JSON.parse(reply.value.text);
          const records = snapshot?.capture?.records ?? snapshot?.records;
          if (Array.isArray(records)) count = records.length;
        } catch {
          /* The prepared file remains immutable even when its format is unfamiliar. */
        }
        setShare({ ...reply.value, count });
        setAccepted(false);
        setShareOpen(false);
      } else if (type === 'revoke') {
        setShare(undefined);
        setAccepted(false);
      }
    } catch {
      if (stillCurrent()) setError(true);
    } finally {
      if (mounted.current && request === shareRequest.current) setShareBusy(false);
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
  const load = async (exportFile = false) => {
    if (!valid()) return;
    const request = ++localRequest.current;
    const stillCurrent = () => valid() && request === localRequest.current;
    setLocalBusy(true);
    setError(false);
    try {
      let snapshot = !exportFile && preview?.token === token ? preview : undefined;
      if (!snapshot) {
        const reply = await chrome.runtime.sendMessage({
          type: 'remote-detailed-preview',
          consent: token,
        });
        if (!stillCurrent()) return;
        if (!reply?.ok) throw new Error('Unavailable');
        const text = JSON.stringify(reply.value, null, 2);
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        if (!stillCurrent()) return;
        const hash = Array.from(new Uint8Array(digest), (x) =>
          x.toString(16).padStart(2, '0'),
        ).join('');
        const records = reply.value?.capture?.records ?? reply.value?.records;
        snapshot = {
          token,
          text,
          hash,
          count: Array.isArray(records) ? records.length : (details?.count ?? 0),
        };
        setPreview(snapshot);
      }
      if (!exportFile) return;
      const reply = await chrome.runtime.sendMessage({
        type: 'remote-detailed-validate',
        consent: token,
      });
      if (!reply?.ok || !reply.value?.valid || !stillCurrent()) {
        if (stillCurrent()) setPreview(undefined);
        return;
      }
      const url = URL.createObjectURL(new Blob([snapshot.text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `zylos-diagnostics-${snapshot.hash.slice(0, 12)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      if (stillCurrent()) setError(true);
    } finally {
      if (mounted.current && request === localRequest.current) setLocalBusy(false);
    }
  };
  return (
    <section className="settings-section detailed-settings" aria-labelledby="detailed-heading">
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
            current.current = '';
            localRequest.current++;
            shareRequest.current++;
            setLocalBusy(false);
            setShareBusy(false);
            setPreview(undefined);
            setShare(undefined);
            setAccepted(false);
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
            id="detailed-download"
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void load(true)}
          >
            {t('detailedDownload')}
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
      {!!token && (preview?.count ?? details?.count ?? 0) === 0 && (
        <p id="detailed-empty" className="settings-hint">
          {t('detailedEmpty')}
        </p>
      )}
      {!!token && (preview?.count ?? details?.count ?? 0) > 0 && (
        <details
          id="detailed-preview"
          className="diagnostic-details"
          open={previewOpen}
          onToggle={(event) => {
            const open = event.currentTarget.open;
            setPreviewOpen(open);
            if (open && !preview && !busy) void load();
          }}
        >
          <summary
            aria-disabled={busy && !preview}
            onClick={(event) => {
              if (busy && !preview) event.preventDefault();
            }}
          >
            {t(previewOpen ? 'detailedHide' : 'detailedPreview')}
          </summary>
          {preview?.token === token ? (
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
            </>
          ) : (
            <p className="settings-hint">{t('loading')}</p>
          )}
        </details>
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
          {share.count !== undefined && (
            <p className="settings-hint">
              {share.count === 0
                ? t('detailedEmpty')
                : t('detailedSnapshotCount', { count: share.count })}
            </p>
          )}
          {share.count !== 0 && (
            <details
              id="detail-share-details"
              className="diagnostic-details"
              open={shareOpen}
              onToggle={(event) => setShareOpen(event.currentTarget.open)}
            >
              <summary>{t(shareOpen ? 'detailedHide' : 'detailedPreview')}</summary>
              <textarea
                id="detail-share-text"
                className="input detailed-preview"
                aria-label={t('detailSharePreview')}
                readOnly
                rows={12}
                value={share.text}
              />
              <p className="settings-hint detailed-hash">SHA-256: {share.sha256}</p>
            </details>
          )}
          <p className="settings-hint">
            {t('detailShareExpires')} {new Date(share.expiresAt).toLocaleTimeString()}
          </p>
          {!authorized && (
            <label className="diagnostic-consent">
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
