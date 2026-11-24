type InputRecoveryProof = {
  scope: object;
  beforeLoss: number;
  afterLoss: number;
};

// Proof stays in-process: page output and transport JSON cannot forge it.
const recoveredInputs = new WeakMap<object, InputRecoveryProof>();

export function markInputRecovery<T extends object>(result: T, proof: InputRecoveryProof): T {
  recoveredInputs.set(result, proof);
  return result;
}

export function consumeInputRecovery(result: unknown): InputRecoveryProof | undefined {
  if (!result || typeof result !== 'object') return;
  const proof = recoveredInputs.get(result);
  recoveredInputs.delete(result);
  return proof;
}

type RecoveredWithoutInput = InputRecoveryProof & {
  recovered: { observation: unknown; target: unknown; pageMayHaveChanged?: true };
};
// Automatic recovery during an input's focus step found a page that may have
// changed (foreign extension frame, #30). The text was NOT sent; the round
// must stop and return the fresh evidence instead of continuing the batch.
const skippedInputs = new WeakMap<object, RecoveredWithoutInput>();

export function markRecoveredWithoutInput<T extends object>(
  result: T,
  proof: RecoveredWithoutInput,
): T {
  skippedInputs.set(result, proof);
  return result;
}

export function consumeRecoveredWithoutInput(result: unknown): RecoveredWithoutInput | undefined {
  if (!result || typeof result !== 'object') return;
  const proof = skippedInputs.get(result);
  skippedInputs.delete(result);
  return proof;
}
