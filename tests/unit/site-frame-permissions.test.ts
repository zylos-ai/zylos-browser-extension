// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PageActions, type ElementRef } from '../../utils/automation/page-actions';
import { assertInputFrames, frameAllowed } from '../../utils/automation/frames';
import {
  assertSiteAction,
  initializeSiteAccess,
  grantSiteAccess,
  revokeSiteAccess,
  siteAccessState,
} from '../../utils/site-access';

const top = { id: 'main', url: 'https://public.example/article' };
const child = { id: 'child', parentId: 'main', url: 'https://finance.example/billing' };
const ref = '@12345678-e1';
let saved: Record<string, unknown>;

beforeEach(async () => {
  saved = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async () => saved),
        set: vi.fn(async (value) => {
          Object.assign(saved, value);
        }),
      },
    },
  });
  await initializeSiteAccess('frame-tests');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(focus: { child: boolean } = { child: false }) {
  let currentChild = { ...child };
  const send = vi.fn(async (method: string, params: any = {}) => {
    if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { pageX: 0, pageY: 0 } };
    if (method === 'Page.getFrameTree')
      return {
        frameTree: { frame: top, childFrames: [{ frame: currentChild }] },
      };
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: 1, frameId: 'child' };
    if (method === 'Runtime.evaluate')
      return { result: focus.child && params.contextId === 1 ? { objectId: 'child-owner' } : {} };
    if (method === 'DOM.describeNode')
      return params.objectId === 'child-owner'
        ? { node: { nodeName: 'IFRAME', frameId: 'child' } }
        : { node: { nodeName: 'DIV' } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'child-node' } };
    if (method === 'Runtime.callFunctionOn') {
      const action = params.arguments[0].value;
      return {
        result: { value: action === 'inspect' ? { disabled: false, clickable: false } : true },
      };
    }
    if (method === 'Page.createIsolatedWorld')
      return { executionContextId: params.frameId === 'main' ? 1 : 2 };
    if (method === 'Accessibility.getFullAXTree')
      return {
        nodes: [
          {
            nodeId: '1',
            role: { value: 'StaticText' },
            name: { value: 'Visible account summary' },
          },
        ],
      };
    return {};
  });
  const refs = new Map<string, ElementRef>([
    [ref, { backendNodeId: 1, generation: 1, frame: child }],
  ]);
  const mouse = vi.fn(async (_params: Record<string, unknown>) => ({}));
  const actions = new PageActions({
    send,
    refs,
    generation: 1,
    mouse,
    check: vi.fn(),
    preview: vi.fn(),
    dragData: vi.fn(),
  });
  return {
    actions,
    send,
    mouse,
    focus,
    navigate: (url: string) => {
      currentChild = { ...child, url };
    },
  };
}

test('a billing iframe stays unavailable by default and grants do not cover subdomains', async () => {
  expect(frameAllowed(child)).toBe(false);
  await grantSiteAccess('https://other.finance.example', 'interactive', 15);
  expect(frameAllowed(child)).toBe(false);
  const { actions, mouse } = setup();
  expect((await actions.safeFrames()).map((frame) => frame.id)).toEqual(['main']);
  await expect(actions.run({ op: 'click', ref })).rejects.toMatchObject({ code: 'STALE_ELEMENT' });
  expect(mouse).not.toHaveBeenCalled();
});

test('read-only iframe allows snapshots but blocks ref and coordinate clicks under an ordinary parent', async () => {
  await grantSiteAccess('https://finance.example', 'read-only', 15);
  const { actions, mouse } = setup();
  expect(frameAllowed(child)).toBe(true);
  expect((await actions.snapshot(false, [])).text).toContain('Visible account summary');
  // Snapshot clears refs; retain an observed child ref for the interaction attempt.
  const observed = setup();
  for (const target of [{ ref }, { x: 10, y: 10 }]) {
    await expect(observed.actions.run({ op: 'click', ...target })).rejects.toMatchObject({
      code: 'SITE_READ_ONLY',
    });
  }
  expect(observed.mouse).not.toHaveBeenCalled();
  expect(mouse).not.toHaveBeenCalled();
});

test.each(['fill', 'type', 'select', 'hover', 'keypress'] as const)(
  'read-only child denies %s without native input',
  async (op) => {
    await grantSiteAccess('https://finance.example', 'read-only', 15);
    // A ref-less keypress goes to the focused frame, so focus the read-only child.
    const { actions, send, mouse } = setup({ child: op === 'keypress' });
    const command =
      op === 'fill' || op === 'type'
        ? { op, ref, text: 'blocked' }
        : op === 'select'
          ? { op, ref, values: ['blocked'] }
          : op === 'keypress'
            ? { op, key: 'Enter' }
            : { op, ref };
    await expect(actions.run(command)).rejects.toMatchObject({ code: 'SITE_READ_ONLY' });
    expect(send.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
    expect(mouse).not.toHaveBeenCalled();
  },
);

test('revoking or downgrading an interactive iframe before input commit denies insertion', async () => {
  await grantSiteAccess('https://finance.example', 'interactive', 15);
  const { actions, send } = setup();
  const prepared = await actions.resolve(ref);
  await grantSiteAccess('https://finance.example', 'read-only', 15);
  await expect(
    actions.commitInput({ op: 'fill', ref, text: 'blocked' }, prepared),
  ).rejects.toMatchObject({ code: 'SITE_READ_ONLY' });
  await revokeSiteAccess(siteAccessState().grants[0]!.id);
  await expect(
    actions.commitInput({ op: 'fill', ref, text: 'blocked' }, prepared),
  ).rejects.toMatchObject({ code: 'FRAME_UNAVAILABLE' });
  expect(send.mock.calls.some(([method]) => method === 'Input.insertText')).toBe(false);
});

test('child navigation between ref preparation and commit cannot inherit the old grant', async () => {
  await grantSiteAccess('https://finance.example', 'interactive', 15);
  const { actions, send, navigate } = setup();
  const prepared = await actions.resolve(ref);
  navigate('https://another.example/billing');
  await expect(
    actions.commitInput({ op: 'fill', ref, text: 'blocked' }, prepared),
  ).rejects.toMatchObject({ code: 'FRAME_UNAVAILABLE' });
  expect(send.mock.calls.some(([method]) => method === 'Input.insertText')).toBe(false);
});

test.each(['denied', 'read-only'] as const)(
  'text for an allowed parent is inserted while an unfocused sibling child is %s',
  async (mode) => {
    await grantSiteAccess('https://finance.example', mode, 15);
    const { actions, send } = setup();
    vi.spyOn(actions, 'resolve').mockResolvedValue({ objectId: 'parent-input', frame: top });
    await expect(actions.commitInput({ op: 'fill', ref, text: 'draft' })).resolves.toEqual({
      done: true,
    });
    expect(send.mock.calls.some(([method]) => method === 'Input.insertText')).toBe(true);
  },
);

test.each(['denied', 'read-only'] as const)(
  'text cannot be inserted while focus is inside a %s child frame',
  async (mode) => {
    await grantSiteAccess('https://finance.example', mode, 15);
    const { actions, send } = setup({ child: true });
    vi.spyOn(actions, 'resolve').mockResolvedValue({ objectId: 'parent-input', frame: top });
    await expect(
      actions.commitInput({ op: 'fill', ref, text: 'private draft' }),
    ).rejects.toMatchObject({ code: mode === 'denied' ? 'BLOCKED_URL' : 'SITE_READ_ONLY' });
    expect(send.mock.calls.some(([method]) => method === 'Input.insertText')).toBe(false);
    expect(send.mock.calls.some(([method]) => method === 'Runtime.callFunctionOn')).toBe(false);
  },
);

test('text commit rechecks the focus chain after DOM focus validation', async () => {
  const { actions, send, navigate, focus } = setup();
  navigate('https://ordinary.example/');
  vi.spyOn(actions, 'resolve').mockResolvedValue({ objectId: 'parent-input', frame: top });
  const original = send.getMockImplementation()!;
  send.mockImplementation(async (method, params) => {
    const result = await original(method, params);
    if (method === 'Runtime.callFunctionOn' && params?.arguments?.[0]?.value === 'commit-input') {
      navigate(child.url);
      focus.child = true;
    }
    return result;
  });
  await expect(
    actions.commitInput({ op: 'type', ref, text: 'private draft' }),
  ).rejects.toMatchObject({ code: 'BLOCKED_URL' });
  expect(send.mock.calls.some(([method]) => method === 'Input.insertText')).toBe(false);
});

test('focus that cannot be resolved falls back to checking every frame', async () => {
  const { actions, send } = setup();
  const original = send.getMockImplementation()!;
  send.mockImplementation(async (method, params) => {
    if (method === 'Runtime.evaluate') throw new Error('Cannot find context');
    return original(method, params);
  });
  vi.spyOn(actions, 'resolve').mockResolvedValue({ objectId: 'parent-input', frame: top });
  await expect(
    actions.commitInput({ op: 'fill', ref, text: 'private draft' }),
  ).rejects.toMatchObject({ code: 'BLOCKED_URL' });
  expect(send.mock.calls.some(([method]) => method === 'Input.insertText')).toBe(false);
});

test.each(['denied', 'read-only'] as const)(
  'keypress rejects focus inside a %s child before querying the permitted parent focus',
  async (mode) => {
    await grantSiteAccess('https://finance.example', mode, 15);
    const { actions, send } = setup({ child: true });
    const query = vi.spyOn(actions, 'query').mockResolvedValue({ focused: false });
    await expect(actions.keypress({ op: 'keypress', key: 'a' })).rejects.toMatchObject({
      code: mode === 'denied' ? 'BLOCKED_URL' : 'SITE_READ_ONLY',
    });
    expect(query).not.toHaveBeenCalled();
    expect(send.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
  },
);

test('keypress is not blocked by an unfocused denied sibling frame', async () => {
  const { actions, send } = setup();
  vi.spyOn(actions, 'query').mockResolvedValue({ focused: false });
  await expect(actions.keypress({ op: 'keypress', key: 'a' })).resolves.toBeTruthy();
  expect(send.mock.calls.some(([method]) => method === 'Input.dispatchKeyEvent')).toBe(true);
});

test('keypress rechecks the focus chain when a child navigates during focus probing', async () => {
  const { actions, send, navigate, focus } = setup();
  navigate('https://ordinary.example/');
  vi.spyOn(actions, 'query').mockImplementation(async () => {
    navigate(child.url);
    focus.child = true;
    return { focused: false };
  });
  await expect(actions.keypress({ op: 'keypress', key: 'a' })).rejects.toMatchObject({
    code: 'BLOCKED_URL',
  });
  expect(send.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
});

test('an interactive grant permits an iframe click without widening its parent policy', async () => {
  await grantSiteAccess('https://finance.example', 'interactive', 15);
  const { actions, mouse } = setup();
  vi.spyOn(actions, 'point').mockResolvedValue({ x: 10, y: 10 });
  await expect(actions.run({ op: 'click', ref })).resolves.toEqual({ done: true });
  expect(mouse.mock.calls.map(([params]) => params.type)).toEqual([
    'mousePressed',
    'mouseReleased',
  ]);
});

test('an interactive child cannot override a read-only parent authorization', async () => {
  await grantSiteAccess('https://finance.example', 'interactive', 15);
  await grantSiteAccess('https://public.example', 'read-only', 15);
  const { actions, mouse } = setup();
  await expect(actions.run({ op: 'click', ref })).rejects.toMatchObject({
    code: 'SITE_READ_ONLY',
  });
  expect(mouse).not.toHaveBeenCalled();
});

test('child accesses and denials create origin-only audit events without duplicate DOM probe entries', async () => {
  await grantSiteAccess('https://finance.example', 'read-only', 15);
  const { actions } = setup();
  await actions.inspect(ref);
  await actions.inspect(ref);
  await expect(actions.run({ op: 'click', ref })).rejects.toMatchObject({
    code: 'SITE_READ_ONLY',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const events = siteAccessState().audit.filter((event) =>
    ['inspect', 'click'].includes(event.action),
  );
  expect(events).toHaveLength(2);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        origin: 'https://finance.example',
        action: 'inspect',
        allowed: true,
      }),
      expect.objectContaining({
        origin: 'https://finance.example',
        action: 'click',
        allowed: false,
      }),
    ]),
  );
  expect(JSON.stringify(events)).not.toContain('/billing');
});

test('revocation during an iframe AX read denies the response instead of publishing it', async () => {
  await grantSiteAccess('https://finance.example', 'read-only', 15);
  const { actions, send } = setup();
  const original = send.getMockImplementation()!;
  send.mockImplementation(async (method, params) => {
    const result = await original(method, params);
    if (method === 'Accessibility.getFullAXTree' && params?.frameId === 'child')
      await revokeSiteAccess(siteAccessState().grants[0]!.id);
    return result;
  });
  await expect(actions.snapshot(false, [])).rejects.toMatchObject({ code: 'BLOCKED_URL' });
});

describe('default payment-provider rule and hidden Stripe frames', () => {
  const linkedin = { id: 'top', url: 'https://www.linkedin.com/in/someone/' };
  const stripe = {
    id: 'stripe',
    parentId: 'top',
    url: 'https://js.stripe.com/v3/m-outer-3437aaddcdf6922d623e172c2d6f9278.html',
    sessionId: 'oopif',
  };
  const send = (focusStripe: boolean) =>
    vi.fn(async (method: string, params: any = {}, sessionId?: string) => {
      if (method === 'Page.getFrameTree')
        return sessionId
          ? { frameTree: { frame: stripe } }
          : { frameTree: { frame: linkedin, childFrames: [{ frame: stripe }] } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 3 };
      if (method === 'Runtime.evaluate')
        return { result: focusStripe && !sessionId ? { objectId: 'iframe' } : {} };
      if (method === 'DOM.describeNode') return { node: { nodeName: 'IFRAME', frameId: 'stripe' } };
      return {};
    });
  const assertFrame = (frame: { url?: string }) => assertSiteAction(frame.url, 'fill');

  test('a hidden js.stripe.com frame does not block input into the top frame', async () => {
    expect(frameAllowed(stripe)).toBe(false);
    await expect(assertInputFrames(send(false), assertFrame)).resolves.toBeUndefined();
  });

  test('input focused inside the js.stripe.com frame is blocked', async () => {
    await expect(assertInputFrames(send(true), assertFrame)).rejects.toMatchObject({
      code: 'BLOCKED_URL',
      message: 'BLOCKED_URL: restricted origin https://js.stripe.com',
    });
  });
});

describe('focus chain resolution', () => {
  // Frames: top (public) > a (public) > b (stripe, restricted). Each frame has
  // its own execution context; `focus` maps a frame to the frame its focused
  // element owns (or a plain element when absent).
  const frames = [
    { id: 'top', url: 'https://www.linkedin.com/feed/' },
    { id: 'a', parentId: 'top', url: 'https://widgets.example/a' },
    { id: 'b', parentId: 'a', url: 'https://js.stripe.com/v3/card', sessionId: 'oopif' },
    { id: 'hidden', parentId: 'top', url: 'https://m.stripe.network/inner.html' },
  ];
  const contexts: Record<string, number> = { top: 1, a: 2, b: 3, hidden: 4 };
  const frameOf = Object.fromEntries(Object.entries(contexts).map(([id, n]) => [n, id]));
  function chain(
    focus: Record<
      string,
      { nodeName: string; frameId?: string; content?: boolean; closedShadow?: boolean }
    >,
  ) {
    const evaluated: string[] = [];
    const send = vi.fn(async (method: string, params: any = {}): Promise<any> => {
      if (method === 'Page.createIsolatedWorld')
        return { executionContextId: contexts[params.frameId] };
      if (method === 'Runtime.evaluate') {
        const frame = frameOf[params.contextId]!;
        evaluated.push(frame);
        return { result: { objectId: `active-in-${frame}` } };
      }
      if (method === 'DOM.describeNode') {
        const owner = focus[String(params.objectId).slice('active-in-'.length)];
        if (!owner) return { node: { nodeName: 'INPUT' } };
        if (owner.closedShadow)
          return {
            node: {
              nodeName: owner.nodeName,
              shadowRoots: [{ nodeName: '#document-fragment', shadowRootType: 'closed' }],
            },
          };
        return {
          node: owner.content
            ? { nodeName: owner.nodeName, contentDocument: { frameId: owner.frameId } }
            : { nodeName: owner.nodeName, frameId: owner.frameId },
        };
      }
      throw new Error(`unexpected ${method}`);
    });
    return { send, evaluated };
  }
  const checked: string[] = [];
  const assertFrame = (frame: { id: string; url?: string }) => {
    checked.push(frame.id);
    assertSiteAction(frame.url, 'fill');
  };
  beforeEach(() => {
    checked.length = 0;
  });

  test('focus on a top-frame input checks only the top frame', async () => {
    const { send, evaluated } = chain({});
    await assertInputFrames(send, assertFrame, frames);
    expect(checked).toEqual(['top']);
    expect(evaluated).toEqual(['top']);
  });

  test('focus inside a permitted child frame checks top and that child only', async () => {
    const { send } = chain({ top: { nodeName: 'IFRAME', frameId: 'a' } });
    await assertInputFrames(send, assertFrame, frames);
    expect(checked).toEqual(['top', 'a']);
  });

  test.each(['IFRAME', 'OBJECT', 'EMBED', 'FRAME'])(
    'focus through a nested %s owner into a restricted frame is blocked',
    async (nodeName) => {
      const { send, evaluated } = chain({
        top: { nodeName: 'IFRAME', frameId: 'a' },
        a: { nodeName, frameId: 'b', content: nodeName === 'FRAME' },
      });
      await expect(assertInputFrames(send, assertFrame, frames)).rejects.toMatchObject({
        code: 'BLOCKED_URL',
      });
      expect(checked).toEqual(['top', 'a', 'b']);
      // The restricted frame itself is never evaluated.
      expect(evaluated).toEqual(['top', 'a']);
    },
  );

  test('focus hidden in a closed shadow root checks every frame', async () => {
    const { send } = chain({ top: { nodeName: 'PAYMENT-WIDGET', closedShadow: true } });
    await expect(assertInputFrames(send, assertFrame, frames)).rejects.toMatchObject({
      code: 'BLOCKED_URL',
    });
    expect(checked).toEqual(['top', 'top', 'a', 'b']);
    expect(send).toHaveBeenCalledWith(
      'DOM.describeNode',
      expect.objectContaining({ pierce: true }),
      undefined,
    );
  });

  test('a user-agent shadow root on a focused input does not widen the check', async () => {
    const { send } = chain({});
    const original = send.getMockImplementation()!;
    send.mockImplementation(async (method: string, params: any = {}) =>
      method === 'DOM.describeNode'
        ? { node: { nodeName: 'INPUT', shadowRoots: [{ shadowRootType: 'user-agent' }] } }
        : original(method, params),
    );
    await assertInputFrames(send, assertFrame, frames);
    expect(checked).toEqual(['top']);
  });

  test('a focused frame missing from the collected frames fails closed', async () => {
    const { send } = chain({ top: { nodeName: 'OBJECT', frameId: 'unknown' } });
    await expect(assertInputFrames(send, assertFrame, frames)).rejects.toMatchObject({
      code: 'FRAME_UNAVAILABLE',
    });
  });

  test('a focused frame claimed by the wrong parent fails closed', async () => {
    const { send } = chain({ top: { nodeName: 'IFRAME', frameId: 'b' } });
    await expect(assertInputFrames(send, assertFrame, frames)).rejects.toMatchObject({
      code: 'FRAME_UNAVAILABLE',
    });
  });

  test('an uninspectable focus checks every frame', async () => {
    const send = vi.fn(async (method: string) => {
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      throw new Error('Cannot find context');
    });
    await expect(assertInputFrames(send, assertFrame, frames)).rejects.toMatchObject({
      code: 'BLOCKED_URL',
    });
    expect(checked).toEqual(['top', 'top', 'a', 'b']);
  });
});
