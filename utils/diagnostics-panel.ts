import { installRuntimeDiagnostics } from './diagnostics-runtime';
import type { PanelDiagnostic } from './diagnostics-schema';
import { installDetailedRuntime } from './detailed-runtime';
import type { DetailEvent } from './detailed-diagnostics';

let consent = '';
let pending = 0;
let suppressed = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
function flushSuppressed() {
  if (!consent || !suppressed || pending >= 20) return;
  const count = suppressed;
  suppressed = 0;
  reportPanelDiagnostic({ event: 'capture-overflow', level: 'warn', count });
}
export function reportPanelDiagnostic(event: PanelDiagnostic) {
  if (!consent) return;
  if (pending >= 20) {
    suppressed = Math.min(suppressed + 1, 1000000);
    return;
  }
  const token = consent;
  pending++;
  let sending: Promise<{ ok?: boolean; value?: { accepted?: boolean } }>;
  try {
    sending = chrome.runtime.sendMessage({
      type: 'remote-diagnostics-event',
      consent: token,
      event,
    });
  } catch {
    sending = Promise.reject(new Error('Diagnostic transport unavailable'));
  }
  void sending
    .then((reply) => {
      if (!reply?.ok || !reply.value?.accepted) throw new Error('Diagnostic event not accepted');
    })
    .catch(() => {
      if (consent === token) {
        suppressed = Math.min(
          suppressed + (event.event === 'capture-overflow' ? (event.count ?? 1) : 1),
          1000000,
        );
        if (!retry)
          retry = setTimeout(() => {
            retry = undefined;
            flushSuppressed();
          }, 1000);
      }
    })
    .finally(() => {
      pending--;
      if (event.event !== 'capture-overflow') flushSuppressed();
    });
}
export function startPanelDiagnostics() {
  const reportVisibility = () =>
    typeof document !== 'undefined' &&
    reportPanelDiagnostic({
      event: 'panel-visibility',
      level: 'info',
      visibility: document.visibilityState === 'visible' ? 'visible' : 'hidden',
    });
  if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', reportVisibility);
  if (typeof window !== 'undefined')
    window.addEventListener('pagehide', () =>
      reportPanelDiagnostic({ event: 'panel-visibility', level: 'info', visibility: 'hidden' }),
    );
  let detailToken = '';
  let detailExpires = 0;
  let detailPending = 0;
  let detailLost = 0;
  const reportDetail = (event: DetailEvent) => {
    if (!detailToken || Date.now() >= detailExpires) return;
    if (detailPending >= 10) {
      detailLost = Math.min(1000000, detailLost + 1);
      return;
    }
    const token = detailToken;
    const lost = detailLost;
    detailLost = 0;
    detailPending++;
    void Promise.resolve()
      .then(() =>
        chrome.runtime.sendMessage({
          type: 'remote-detailed-event',
          consent: token,
          event: { ...event, lost },
        }),
      )
      .then((reply) => {
        if (!reply?.ok || !reply.value?.accepted) throw new Error('Not accepted');
      })
      .catch(() => {
        if (token === detailToken) detailLost = Math.min(1000000, detailLost + lost + 1);
      })
      .finally(() => {
        detailPending--;
        if (token === detailToken && detailLost && event.kind !== 'panel-loss')
          reportDetail({
            kind: 'panel-loss',
            level: 'warn',
            at: Date.now(),
            text: 'Panel events were dropped.',
            truncated: true,
          });
      });
  };
  installDetailedRuntime(reportDetail, () => !!detailToken && Date.now() < detailExpires);
  let receivedUpdate = false;
  const update = (state: {
    diagnosticsEnabled?: boolean;
    diagnosticsConsent?: string;
    detailedDiagnostics?: { enabled: boolean; consent: string; expiresAt: number };
  }) => {
    const nextDetail = state.detailedDiagnostics?.enabled ? state.detailedDiagnostics.consent : '';
    if (nextDetail !== detailToken) detailLost = 0;
    detailToken = nextDetail;
    detailExpires = state.detailedDiagnostics?.expiresAt ?? 0;
    const next =
      state.diagnosticsEnabled && typeof state.diagnosticsConsent === 'string'
        ? state.diagnosticsConsent
        : '';
    if (next !== consent) {
      suppressed = 0;
      clearTimeout(retry);
      retry = undefined;
    }
    const changed = consent !== next;
    consent = next;
    if (changed && consent) reportVisibility();
  };
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'remote-updated' && message.state) {
      receivedUpdate = true;
      update(message.state);
    }
  });
  void chrome.runtime
    .sendMessage({ type: 'remote-state' })
    .then((reply) => {
      if (!receivedUpdate && reply?.ok && reply.value) update(reply.value);
    })
    .catch(() => {});
  installRuntimeDiagnostics(reportPanelDiagnostic);
}
