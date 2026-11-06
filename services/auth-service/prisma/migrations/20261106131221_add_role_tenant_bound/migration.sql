-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "tenant_bound" BOOLEAN NOT NULL DEFAULT false;

-- Hand-written: of the built-in roles only OPERATOR is tenant-bound (ADR-0025). Found by key, not by id.
UPDATE "roles" SET "tenant_bound" = true WHERE "key" = 'OPERATOR';
