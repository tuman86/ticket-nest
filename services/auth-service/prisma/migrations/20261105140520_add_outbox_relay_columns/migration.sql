-- AlterTable
ALTER TABLE "outbox" ADD COLUMN     "failed_at" TIMESTAMPTZ(3),
ADD COLUMN     "locked_by" TEXT,
ADD COLUMN     "locked_until" TIMESTAMPTZ(3);
