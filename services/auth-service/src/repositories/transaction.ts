/**
 * Opaque handle to an open database transaction. Services receive it from `UnitOfWork.run` and
 * pass it straight to repository methods; they never look inside it.
 */
export interface Transaction {
  readonly isTransaction: true;
}

/** Runs several repository calls as ONE transaction. Opened by services, never by repositories. */
export interface UnitOfWork {
  /**
   * Runs `work` inside a transaction. It commits when `work` resolves and rolls back when it throws.
   *
   * @param work - Receives the transaction handle to pass to every repository call.
   * @returns Whatever `work` returns.
   */
  run<Result>(work: (tx: Transaction) => Promise<Result>): Promise<Result>;
}
