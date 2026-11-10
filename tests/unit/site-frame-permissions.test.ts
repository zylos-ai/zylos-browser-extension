// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PageActions, type ElementRef } from '../../utils/automation/page-actions';
import { frameAllowed } from '../../utils/automation/frames';
import {
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

function setup() {
  let currentChild = { ...child };
  const send = vi.fn(async (method: string, params: any = {}) => {
    if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { pageX: 0, pageY: 0 } };
    if (method === 'Page.getFrameTree')
      return {
        frameTree: { frame: top, childFrames: [{ frame: currentChild }] },
      };
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: 1, frameId: 'child' };
    if (method === 'DOM.describeNode') return { node: { nodeName: 'DIV' } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'child-node' } };
    if (method === 'Runtime.callFunctionOn') {
      const action = params.arguments[0].value;
      return {
        result: { value: action === 'inspect' ? { disabled: false, clickable: false } : true },
      };
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
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
    const { actions, send, mouse } = setup();
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
  'text for an allowed parent cannot be inserted while a sibling child is %s',
  async (mode) => {
    await grantSiteAccess('https://finance.example', mode, 15);
    const { actions, send } = setup();
    vi.spyOn(actions, 'resolve').mockResolvedValue({ objectId: 'parent-input', frame: top });
    await expect(
      actions.commitInput({ op: 'fill', ref, text: 'private draft' }),
    ).rejects.toMatchObject({ code: mode === 'denied' ? 'BLOCKED_URL' : 'SITE_READ_ONLY' });
    expect(send.mock.calls.some(([method]) => method === 'Input.insertText')).toBe(false);
    expect(send.mock.calls.some(([method]) => method === 'Runtime.callFunctionOn')).toBe(false);
  },
);

test('text commit rechecks all frames after DOM focus validation', async () => {
  const { actions, send, navigate } = setup();
  navigate('https://ordinary.example/');
  vi.spyOn(actions, 'resolve').mockResolvedValue({ objectId: 'parent-input', frame: top });
  const original = send.getMockImplementation()!;
  send.mockImplementation(async (method, params) => {
    const result = await original(method, params);
    if (method === 'Runtime.callFunctionOn' && params?.arguments?.[0]?.value === 'commit-input')
      navigate(child.url);
    return result;
  });
  await expect(
    actions.commitInput({ op: 'type', ref, text: 'private draft' }),
  ).rejects.toMatchObject({ code: 'BLOCKED_URL' });
  expect(send.mock.calls.some(([method]) => method === 'Input.insertText')).toBe(false);
});

test.each(['denied', 'read-only'] as const)(
  'keypress rejects a %s sibling before querying the permitted parent focus',
  async (mode) => {
    await grantSiteAccess('https://finance.example', mode, 15);
    const { actions, send } = setup();
    const query = vi.spyOn(actions, 'query').mockResolvedValue({ focused: false });
    await expect(actions.keypress({ op: 'keypress', key: 'a' })).rejects.toMatchObject({
      code: mode === 'denied' ? 'BLOCKED_URL' : 'SITE_READ_ONLY',
    });
    expect(query).not.toHaveBeenCalled();
    expect(send.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
  },
);

test('keypress rechecks all frames when a child navigates during focus probing', async () => {
  const { actions, send, navigate } = setup();
  navigate('https://ordinary.example/');
  vi.spyOn(actions, 'query').mockImplementation(async () => {
    navigate(child.url);
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
