import { type Prisma, type PrismaClient } from '../generated/prisma/client';

import { type Transaction } from './transaction';

/** Either the shared client or the client bound to one open transaction. */
export type PrismaExecutor = PrismaClient | Prisma.TransactionClient;

/** The Prisma-backed transaction handle. Only repositories read `client` from it. */
export class PrismaTransaction implements Transaction {
  readonly isTransaction = true as const;

  /**
   * @param client - The Prisma client bound to the open transaction.
   */
  constructor(readonly client: Prisma.TransactionClient) {}
}

/**
 * Picks the client a repository call must use.
 *
 * @param defaultClient - The shared client, used when no transaction is given.
 * @param tx - The handle from `UnitOfWork.run`, if the call is part of a transaction.
 * @returns The transaction's client when `tx` is given, otherwise `defaultClient`.
 * @throws TypeError when `tx` was not created by `PrismaUnitOfWork`.
 */
export function selectExecutor(
  defaultClient: PrismaClient,
  tx: Transaction | undefined,
): PrismaExecutor {
  if (tx === undefined) {
    return defaultClient;
  }
  if (!(tx instanceof PrismaTransaction)) {
    throw new TypeError('Transaction handle was not created by PrismaUnitOfWork.');
  }
  return tx.client;
}
