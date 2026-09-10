import { describe, expect, it } from 'vitest';
import {
  bindingCallbackAllowed,
  browserOperationError,
  newerPlatformTask,
  platformRequestSchema,
  platformTaskSchema,
  chatActionSenderAllowed,
  deviceProbeSchema,
  deviceProofSchema,
  assertInitialTaskURL,
  type PlatformTask,
} from '../../utils/platform';

describe('platform trust boundary', () => {
  it('首步必须匹配授权卡保存的网站，不能换成别的任务', () => {
    const task = { initial_url: 'https://example.com' } as PlatformTask;
    expect(() => assertInitialTaskURL(task, 'https://example.com/')).not.toThrow();
    expect(() => assertInitialTaskURL(task, 'https://evil.test')).toThrow('TASK_PLAN_CHANGED');
    expect(() => assertInitialTaskURL(task, 'https://example.com/buy')).toThrow(
      'TASK_PLAN_CHANGED',
    );
  });
  it('accepts RFC3339 intent expiry with an explicit server timezone', () => {
    const intent = {
      browser_proof: 'p'.repeat(100),
      owner_identity_id: '11111111-1111-4111-8111-111111111111',
      connection_epoch: '11111111-1111-4111-8111-111111111111',
      endpoint_id: '11111111-1111-4111-8111-111111111111',
      org_id: '11111111-1111-4111-8111-111111111111',
      action: 'approve',
      revision: '1',
      expires_at: '2026-09-09T01:00:00.123+08:00',
    };
    expect(deviceProofSchema.safeParse(intent).success).toBe(true);
    expect(
      deviceProofSchema.safeParse({ ...intent, expires_at: '2026-09-09T01:00:00' }).success,
    ).toBe(false);
  });
  it('limits chat consent to top-level OpenMAX tabs and a strict single-use-code message', () => {
    const tab = {
      id: 1,
      url: 'http://localhost:3000/workspace?chat=x',
      incognito: false,
    } as chrome.tabs.Tab;
    const sender = {
      url: tab.url,
      frameId: 0,
      tab,
    } as chrome.runtime.MessageSender;
    expect(chatActionSenderAllowed(sender, tab)).toBe(true);
    for (const change of [
      { frameId: 1 },
      { frameId: undefined },
      { tab: undefined },
      { tab: { ...tab, incognito: true } },
      { url: 'https://evil.test/workspace' },
      { url: 'http://localhost:3001/workspace' },
      { url: undefined },
      { origin: 'null' },
      { origin: 'https://evil.test' },
    ])
      expect(chatActionSenderAllowed({ ...sender, ...change }, tab)).toBe(false);
    for (const change of [
      { id: 2 },
      { incognito: true },
      { url: undefined },
      { url: 'http://localhost:3000/workspace/account' },
      { url: 'https://evil.test/workspace' },
      { url: 'http://localhost:3001/workspace' },
    ])
      expect(chatActionSenderAllowed(sender, { ...tab, ...change })).toBe(false);
    expect(chatActionSenderAllowed(sender, undefined)).toBe(false);
    const m = {
      type: 'browser-device-probe',
      revision: '1',
      taskId: '11111111-1111-4111-8111-111111111111',
    };
    expect(deviceProbeSchema.safeParse(m).success).toBe(true);
    for (const change of [{ revision: '' }, { action: 'approve' }, { token: 'login-token' }])
      expect(deviceProbeSchema.safeParse({ ...m, ...change }).success).toBe(false);
  });
  it('accepts same-origin SPA navigation into chat without trusting the stale sender route', () => {
    const tab = {
      id: 1,
      incognito: false,
      url: 'http://localhost:3000/workspace',
    } as chrome.tabs.Tab;
    const sender = {
      url: 'http://localhost:3000/workspace/account',
      origin: 'http://localhost:3000',
      frameId: 0,
      tab: { ...tab, url: 'http://localhost:3000/workspace/account' },
    };
    expect(chatActionSenderAllowed(sender, tab)).toBe(true);
    // The same sender must be rejected if the live tab leaves chat again.
    expect(chatActionSenderAllowed(sender, { ...tab, url: sender.url })).toBe(false);
  });
  it('preserves executor error codes so open can navigate a blank work tab', () => {
    expect(
      browserOperationError(
        Object.assign(new Error('Open a normal page'), { code: 'NO_CONTROLLABLE_TAB' }),
      ),
    ).toEqual({ code: 'NO_CONTROLLABLE_TAB', message: 'Open a normal page' });
    expect(browserOperationError(new Error('Unexpected'))).toEqual({
      code: 'BROWSER_ERROR',
      message: 'Unexpected',
    });
  });
  it('does not roll back a new decision with an older polling response', () => {
    const t = platformTaskSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      owner_identity_id: '11111111-1111-4111-8111-111111111111',
      connection_epoch: '11111111-1111-4111-8111-111111111111',
      endpoint_id: '11111111-1111-4111-8111-111111111111',
      activation_id: '11111111-1111-4111-8111-111111111111',
      state: 'running',
      revision: '3',
      control_session_id: 'session',
      deadline: 'time',
      absolute_deadline: 'time',
      outcome: '',
      cleanup_state: 'pending',
    });
    expect(newerPlatformTask(t, { ...t, state: 'awaiting_consent', revision: '1' })).toBe(t);
    expect(newerPlatformTask(t, { ...t, state: 'closed', revision: '4' })?.state).toBe('closed');
    expect(newerPlatformTask(t, null)).toBe(t);
  });
  it('binds login callback to exact local page and nonce', () => {
    const tab = {
      id: 7,
      incognito: false,
      url: 'http://localhost:3000/workspace/account?code=x',
    } as chrome.tabs.Tab;
    const sender = { frameId: 0, tab, url: tab.url } as chrome.runtime.MessageSender;
    expect(bindingCallbackAllowed(sender, 'nonce', 'nonce', tab)).toBe(true);
    for (const url of [
      'https://evil.test/workspace/account',
      'http://localhost:3001/workspace/account',
      'http://localhost:3000/workspace',
      'http://localhost:3000/workspace/other',
      'http://localhost:3000/workspace/browser/connect',
      'http://localhost:3000/workspace/connections',
    ])
      expect(bindingCallbackAllowed(sender, 'nonce', 'nonce', { ...tab, url })).toBe(false);
    expect(bindingCallbackAllowed(sender, 'nonce', 'stale', tab)).toBe(false);
    expect(bindingCallbackAllowed(sender, '', '', tab)).toBe(false);
    expect(bindingCallbackAllowed(sender, 'nonce', 'nonce', undefined)).toBe(false);
    expect(
      bindingCallbackAllowed(
        { ...sender, url: 'https://evil.test/workspace/account' },
        'nonce',
        'nonce',
        tab,
      ),
    ).toBe(false);
    expect(
      bindingCallbackAllowed(
        { ...sender, url: 'http://localhost:3000/workspace' },
        'nonce',
        'nonce',
        tab,
      ),
    ).toBe(true);
  });
  it('rejects task decisions without exact task id and unknown privileged fields', () => {
    expect(
      platformRequestSchema.safeParse({ type: 'platform-decide', action: 'approve' }).success,
    ).toBe(false);
    expect(
      platformRequestSchema.safeParse({ type: 'platform-login', token: 'not-allowed' }).success,
    ).toBe(false);
    expect(platformTaskSchema.safeParse({ state: 'running' }).success).toBe(false);
  });
});
