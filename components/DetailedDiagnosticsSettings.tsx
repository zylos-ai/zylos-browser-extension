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
  useEffect(() => {
    setPreview(undefined);
    setError(false);
  }, [token]);
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
    </section>
  );
}
