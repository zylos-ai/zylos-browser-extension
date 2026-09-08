// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { AuthorizationController } from '../../utils/authorization';
const request = () => ({
  id: crypto.randomUUID(),
  requestContext: crypto.randomUUID(),
  goal: '打开网站',
  tool: 'agent_browser_open',
  status: 'pending' as const,
  expiresAt: Date.now() + 300000,
});
function setup() {
  const io = {
    publish: vi.fn(),
    send: vi.fn(),
    release: vi.fn(async () => {}),
    grant: vi.fn(async (_windowId: number, check: () => void) => {
      check();
      return 'session';
    }),
  };
  return { io, controller: new AuthorizationController(io), pending: request() };
}
afterEach(() => vi.useRealTimers());
test('a server request never grants; one explicit approval waits for server acknowledgement', async () => {
  vi.useFakeTimers();
  const { io, controller, pending } = setup();
  controller.receive(pending);
  expect(io.grant).not.toHaveBeenCalled();
  await controller.approve(pending.id, 7);
  expect(io.grant).toHaveBeenCalledTimes(1);
  expect(io.send).toHaveBeenCalledWith({
    type: 'authorization-decision',
    id: pending.id,
    approved: true,
    controlSessionId: 'session',
  });
  await expect(controller.approve(pending.id, 7)).rejects.toThrow();
  controller.receive({ ...pending, status: 'approved' });
  expect(controller.state?.status).toBe('approved');
  await vi.advanceTimersByTimeAsync(400000);
  expect(io.release).not.toHaveBeenCalled();
});
test.each(['denied', 'expired', 'cancelled'] as const)(
  '%s never grants and late clicks are rejected',
  async (status) => {
    vi.useFakeTimers();
    const { io, controller, pending } = setup();
    controller.receive(pending);
    if (status === 'expired') await vi.advanceTimersByTimeAsync(300001);
    else controller.cancel(status);
    await expect(controller.approve(pending.id, 7)).rejects.toThrow();
    expect(io.grant).not.toHaveBeenCalled();
    expect(controller.state?.status).toBe(status);
  },
);
test('cancel during asynchronous tab lookup prevents attaching or sending an approved decision', async () => {
  vi.useFakeTimers();
  const { io, controller, pending } = setup();
  let proceed!: () => void;
  const attaching = vi.fn();
  io.grant.mockImplementation(async (_windowId, check) => {
    await new Promise<void>((resolve) => {
      proceed = resolve;
    });
    check();
    attaching();
    return 'session';
  });
  controller.receive(pending);
  const approving = controller.approve(pending.id, 7);
  const rejected = expect(approving).rejects.toThrow();
  controller.cancel();
  proceed();
  await rejected;
  expect(attaching).not.toHaveBeenCalled();
  expect(io.send.mock.calls.some(([m]) => (m as { approved?: boolean }).approved)).toBe(false);
});
test('new request ignores old acknowledgements and duplicate pending does not reset approval', async () => {
  vi.useFakeTimers();
  const { io, controller, pending } = setup();
  controller.receive(pending);
  await controller.approve(pending.id, 7);
  controller.receive(pending);
  expect(controller.state?.status).toBe('approving');
  const next = request();
  controller.receive(next);
  controller.receive({ ...pending, status: 'approved' });
  expect(controller.state?.id).toBe(next.id);
  expect(controller.state?.status).toBe('pending');
  expect(io.release).toHaveBeenCalled();
});
test('a late approval acknowledgement cannot revive cancelled or expired local consent', async () => {
  vi.useFakeTimers();
  for (const reason of ['cancelled', 'expired'] as const) {
    const { controller, pending, io } = setup();
    controller.receive(pending);
    await controller.approve(pending.id, 7);
    controller.cancel(reason);
    controller.receive({ ...pending, status: 'approved' });
    expect(controller.state?.status).toBe(reason);
    expect(io.release).toHaveBeenCalled();
  }
});
