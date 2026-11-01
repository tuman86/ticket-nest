import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Header carrying the caller-supplied correlation id (see docs/api/common.yaml). */
export const REQUEST_ID_HEADER = 'x-request-id';

interface CorrelationStore {
  readonly correlationId: string;
}

const correlationStorage = new AsyncLocalStorage<CorrelationStore>();

export function generateCorrelationId(): string {
  return randomUUID();
}

/** Runs `work` so every log line written inside it (even after awaits) carries `correlationId`. */
export function runWithCorrelationId<Result>(correlationId: string, work: () => Result): Result {
  return correlationStorage.run({ correlationId }, work);
}

export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}
