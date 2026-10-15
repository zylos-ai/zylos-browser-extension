import { installRuntimeDiagnostics } from './diagnostics-runtime';
import type { PanelDiagnostic } from './diagnostics-schema';

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
  try { sending = chrome.runtime.sendMessage({ type: 'remote-diagnostics-event', consent: token, event }); }
  catch { sending = Promise.reject(new Error('Diagnostic transport unavailable')); }
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
  let receivedUpdate = false;
  const update = (state: { diagnosticsEnabled?: boolean; diagnosticsConsent?: string }) => {
    const next =
      state.diagnosticsEnabled && typeof state.diagnosticsConsent === 'string'
        ? state.diagnosticsConsent
        : '';
    if (next !== consent) {
      suppressed = 0;
      clearTimeout(retry);
      retry = undefined;
    }
    consent = next;
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
