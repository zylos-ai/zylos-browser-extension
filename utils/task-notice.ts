import { z } from 'zod';
import { translate, type Locale, type TranslationKey } from './i18n';

// Local history metadata, never inferred from Agent or owner text. Keep a plain
// text fallback for the relay, while the panel can render the current language.
export const taskNoticeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['time-limit', 'execution-limit', 'interrupted']) }).strict(),
  z.object({ kind: z.literal('request-failed'), code: z.string().max(128) }).strict(),
]);
export type TaskNotice = z.infer<typeof taskNoticeSchema>;

const reasonKeys: Record<string, TranslationKey> = {
  DECISION_TIMEOUT: 'taskDecisionTimeout',
  DECISION_WAIT_TIMEOUT: 'taskDecisionTimeout',
  SEND_FAILED: 'sendFailed',
  AGENT_UNAVAILABLE: 'agentUnavailable',
  AGENT_STOPPING: 'taskAgentStopping',
  TURN_BUSY: 'chatBusy',
  DECISION_BUSY: 'chatBusy',
  C4_DELIVERY_FAILED: 'chatDeliveryFailed',
  C4_DELIVERY_TIMEOUT: 'deliveryUnconfirmed',
  C4_DELIVERY_UNCONFIRMED: 'deliveryUnconfirmed',
  ATTACHMENT_FAILED: 'taskAttachmentFailed',
  AGENT_REQUEST_TOO_LARGE: 'taskRequestTooLarge',
  BAD_AGENT_REQUEST: 'protocolMismatch',
  EXT_OFFLINE: 'progressDisconnected',
  STALE_DECISION: 'taskDecisionExpired',
};
export function formatTaskNotice(locale: Locale, notice: TaskNotice): string {
  switch (notice.kind) {
    case 'time-limit':
      return translate(locale, 'taskTimeLimit');
    case 'execution-limit':
      return translate(locale, 'taskExecutionLimit');
    case 'interrupted':
      return translate(locale, 'taskInterrupted');
    case 'request-failed': {
      const key = Object.hasOwn(reasonKeys, notice.code) ? reasonKeys[notice.code] : undefined;
      const reason = key
        ? translate(locale, key)
        : translate(locale, 'taskRequestFailed', { code: notice.code });
      return translate(locale, 'taskCannotContinue', { reason });
    }
  }
}
