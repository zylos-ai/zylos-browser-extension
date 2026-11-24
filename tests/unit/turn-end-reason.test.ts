import { expect, it } from 'vitest';
import { turnEndReason } from '../../utils/control-loss';

it('prefers concrete causes, then the receipt outcome, then the executor cause', () => {
  expect(turnEndReason('expired', 'recovery_failed')).toBe('recovery_expired');
  expect(turnEndReason('revoked', 'target_closed')).toBe('recovery_failed');
  expect(turnEndReason('expired', 'tab_closed')).toBe('tab_closed');
  expect(turnEndReason('failed', 'foreign_frame')).toBe('foreign_frame');
  expect(turnEndReason(undefined, 'canceled_by_user')).toBe('canceled_by_user');
  expect(turnEndReason(undefined, undefined)).toBe('other');
});
