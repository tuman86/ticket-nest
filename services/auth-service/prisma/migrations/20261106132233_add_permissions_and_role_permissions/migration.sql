-- CreateTable
CREATE TABLE "permissions" (
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_key")
);

-- CreateIndex
CREATE INDEX "role_permissions_permission_key_idx" ON "role_permissions"("permission_key");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "permissions"("key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: the key shape, the same pattern as PERMISSION_KEY_PATTERN in packages/contracts.
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_key_format_check" CHECK ("key" ~ '^[a-z_]+:[a-z_]+(:[a-z_]+)?$');

-- Hand-written: reference data. The permission catalogue, copied from PERMISSION_CATALOGUE in
-- packages/contracts (ADR-0025). A later key is a new migration that only adds rows.
INSERT INTO "permissions" ("key", "description") VALUES
    ('user:manage', 'Create staff users and change a user''s role, tenant or status.'),
    ('user:read:any', 'View and list any user.'),
    ('user:read:tenant', 'View and list the users of their own tenant.'),
    ('role:manage', 'Create, edit and delete roles, and view the permission list.'),
    ('operator:manage', 'List, onboard, edit and suspend operators.'),
    ('operator:read:own', 'View their own operator record.'),
    ('inventory:read', 'View venues, screens, routes and bus and coach layouts.'),
    ('inventory:create', 'Create venues, screens, routes, layouts and trains.'),
    ('inventory:update', 'Edit venues, screens, routes, layouts and trains.'),
    ('inventory:delete', 'Delete venues, screens, routes, layouts and trains.'),
    ('schedule:read', 'View schedules that are not published yet.'),
    ('schedule:manage', 'Create, edit, delete and publish schedules.'),
    ('schedule:cancel', 'Cancel a show or trip, which refunds its bookings.'),
    ('movie:manage', 'Create, edit and delete movies.'),
    ('station:manage', 'Create and edit stations.'),
    ('policy:manage', 'Publish a new cancellation policy version.'),
    ('fee:manage', 'Replace the convenience fee settings.'),
    ('booking:read:any', 'View any booking.'),
    ('booking:read:tenant', 'View the bookings of their own tenant.'),
    ('booking:cancel:any', 'Cancel a booking on a customer''s behalf.'),
    ('refund:issue', 'Issue a goodwill refund up to the allowed limit.'),
    ('refund:approve', 'Approve a refund above the allowed limit.');

-- Hand-written: reference data. The default grants of the built-in roles from docs/permissions.md
-- section 3 (ADR-0025). Grants marked as assumed there (a starred tick) are seeded for ADMIN only
-- until the owner confirms them. Roles are found by roles.key; a permission key is its own id.
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT "roles"."id", "seed"."permission_key"
FROM (VALUES
    -- ADMIN: 22 grants
    ('ADMIN', 'user:manage'),
    ('ADMIN', 'user:read:any'),
    ('ADMIN', 'user:read:tenant'),
    ('ADMIN', 'role:manage'),
    ('ADMIN', 'operator:manage'),
    ('ADMIN', 'operator:read:own'),
    ('ADMIN', 'inventory:read'),
    ('ADMIN', 'inventory:create'),
    ('ADMIN', 'inventory:update'),
    ('ADMIN', 'inventory:delete'),
    ('ADMIN', 'schedule:read'),
    ('ADMIN', 'schedule:manage'),
    ('ADMIN', 'schedule:cancel'),
    ('ADMIN', 'movie:manage'),
    ('ADMIN', 'station:manage'),
    ('ADMIN', 'policy:manage'),
    ('ADMIN', 'fee:manage'),
    ('ADMIN', 'booking:read:any'),
    ('ADMIN', 'booking:read:tenant'),
    ('ADMIN', 'booking:cancel:any'),
    ('ADMIN', 'refund:issue'),
    ('ADMIN', 'refund:approve'),
    -- OPERATOR: 8 grants
    ('OPERATOR', 'operator:read:own'),
    ('OPERATOR', 'inventory:read'),
    ('OPERATOR', 'inventory:create'),
    ('OPERATOR', 'inventory:update'),
    ('OPERATOR', 'inventory:delete'),
    ('OPERATOR', 'schedule:read'),
    ('OPERATOR', 'schedule:manage'),
    ('OPERATOR', 'schedule:cancel'),
    -- SUPPORT_AGENT: 2 grants
    ('SUPPORT_AGENT', 'booking:read:any'),
    ('SUPPORT_AGENT', 'refund:issue')
    -- CUSTOMER: no grants
) AS "seed" ("role_key", "permission_key")
JOIN "roles" ON "roles"."key" = "seed"."role_key";
