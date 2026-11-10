// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { assertPointPermissions } from '../../utils/automation/point-permissions';
import { assertSiteAction, initializeSiteAccess, grantSiteAccess } from '../../utils/site-access';
import { clearFrameSessions, frameSessions } from '../../utils/automation/frames';

async function setup(mode: 'denied' | 'read-only' | 'interactive', nested = false) {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}), set: async () => {} } } });
  await initializeSiteAccess('point-tests');
  await grantSiteAccess('https://child.test', mode, 15);
  clearFrameSessions();
  frameSessions().set('oopif', { tabId: 1, frameId: 'child' });
  const top = { id: 'main', url: 'https://parent.test' };
  const child = { id: 'child', parentId: 'main', url: 'https://child.test' };
  const tree = {
    frame: child,
    ...(nested ? { childFrames: [{ frame: { id: 'nested', url: 'https://paypal.com' } }] } : {}),
  };
  const send = vi.fn(async (method: string, _params: any = {}, session?: string): Promise<any> => {
    if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { pageX: 0, pageY: 0 } };
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: 42, frameId: 'main' };
    if (method === 'DOM.describeNode') return { node: { nodeName: 'IFRAME', frameId: 'child' } };
    if (method === 'Page.getFrameTree')
      return {
        frameTree: session === 'oopif' ? tree : { frame: top, childFrames: [{ frame: child }] },
      };
    return {};
  });
  return send;
}

test.each(['denied', 'read-only'] as const)(
  'parent-session iframe hit checks a %s OOPIF before coordinate input',
  async (mode) => {
    const send = await setup(mode);
    await expect(
      assertPointPermissions(send, { x: 10, y: 10 }, (frame) =>
        assertSiteAction(frame.url, 'click'),
      ),
    ).rejects.toMatchObject({ code: mode === 'denied' ? 'BLOCKED_URL' : 'SITE_READ_ONLY' });
    expect(send).toHaveBeenCalledWith('Page.getFrameTree', {}, 'oopif');
    expect(send).toHaveBeenCalledWith(
      'DOM.describeNode',
      { backendNodeId: 42, depth: 0 },
      undefined,
    );
    clearFrameSessions();
    vi.unstubAllGlobals();
  },
);

test('authorized iframe subtree permits coordinate input', async () => {
  const send = await setup('interactive');
  await expect(
    assertPointPermissions(send, { x: 10, y: 10 }, (frame) => assertSiteAction(frame.url, 'click')),
  ).resolves.toBeUndefined();
  clearFrameSessions();
  vi.unstubAllGlobals();
});

test('restricted nested frame blocks its whole embedding subtree conservatively', async () => {
  const send = await setup('interactive', true);
  await expect(
    assertPointPermissions(send, { x: 10, y: 10 }, (frame) => assertSiteAction(frame.url, 'click')),
  ).rejects.toMatchObject({ code: 'BLOCKED_URL' });
  clearFrameSessions();
  vi.unstubAllGlobals();
});

test('missing embedded frame identity fails closed', async () => {
  const send = await setup('interactive');
  const original = send.getMockImplementation()!;
  send.mockImplementation((method, params, session) =>
    method === 'DOM.describeNode'
      ? Promise.resolve({ node: { nodeName: 'IFRAME' } })
      : original(method, params, session),
  );
  await expect(assertPointPermissions(send, { x: 10, y: 10 }, () => {})).rejects.toMatchObject({
    code: 'FRAME_UNAVAILABLE',
  });
  clearFrameSessions();
  vi.unstubAllGlobals();
});

test.each(['denied', 'read-only'] as const)(
  'a scrolled viewport hit still checks the %s cross-process child',
  async (mode) => {
    const send = await setup(mode);
    const original = send.getMockImplementation()!;
    send.mockImplementation(async (method, params, session) => {
      if (method === 'Page.getLayoutMetrics')
        return { cssVisualViewport: { pageX: 100, pageY: 1900 } };
      if (method === 'DOM.getNodeForLocation') {
        expect(params).toMatchObject({ x: 160, y: 2050 });
        return original(method, params, session);
      }
      return original(method, params, session);
    });
    await expect(
      assertPointPermissions(send, { x: 60, y: 150 }, (frame) =>
        assertSiteAction(frame.url, 'click'),
      ),
    ).rejects.toMatchObject({ code: mode === 'denied' ? 'BLOCKED_URL' : 'SITE_READ_ONLY' });
    clearFrameSessions();
    vi.unstubAllGlobals();
  },
);
