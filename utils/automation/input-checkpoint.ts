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
