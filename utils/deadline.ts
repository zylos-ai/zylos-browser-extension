/**
 * Race a promise against a wall-clock budget. Chrome extension APIs can leave a
 * promise pending forever (wedged debugger target, tab drag, group mutation);
 * callers that own a round must not inherit that hang.
 *
 * The underlying work is not cancelled. Callers must fence any side effects
 * that could land after the budget (scope/generation checks).
 */
export class DeadlineExceeded extends Error {
  readonly code = 'DEADLINE_EXCEEDED';
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`${label} did not finish within ${timeoutMs}ms`);
  }
}

export function withDeadline<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineExceeded(label, timeoutMs)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Wait for a queue to drain, but never longer than the budget; never rejects. */
export async function drainWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  try {
    await withDeadline(
      work.catch(() => {}),
      timeoutMs,
      'drain',
    );
    return true;
  } catch {
    return false;
  }
}
