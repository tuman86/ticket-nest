import { type PrismaClient } from '../generated/prisma/client';

import { PrismaTransaction } from './prisma-transaction';
import { type Transaction, type UnitOfWork } from './transaction';

/** `UnitOfWork` backed by Prisma's interactive transactions. */
export class PrismaUnitOfWork implements UnitOfWork {
  /**
   * @param client - The shared Prisma client that opens the transactions.
   */
  constructor(private readonly client: PrismaClient) {}

  /**
   * Runs `work` in one interactive transaction (commit on success, rollback on a throw).
   *
   * @param work - Receives the transaction handle to pass to every repository call.
   * @returns Whatever `work` returns.
   */
  run<Result>(work: (tx: Transaction) => Promise<Result>): Promise<Result> {
    return this.client.$transaction((transactionClient) =>
      work(new PrismaTransaction(transactionClient)),
    );
  }
}
