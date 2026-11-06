import { z } from 'zod';

/**
 * Shape of a permission key: `resource:action` or `resource:action:scope`, lower case. Mirrors
 * `PermissionKey` in `docs/api/auth-service.openapi.yaml`.
 */
export const PERMISSION_KEY_PATTERN = /^[a-z_]+:[a-z_]+(:[a-z_]+)?$/;

/** One catalogue entry: the key a role can hold and the text a role-editing screen shows for it. */
interface PermissionDefinition {
  readonly key: string;
  readonly description: string;
}

/**
 * Every permission key the platform understands, with a short description for a role-editing
 * screen. The order follows `docs/permissions.md`.
 *
 * This list is the typed source ADR-0025 names. A key is added in one change to five places: this
 * constant, `docs/permissions.md`, the `x-permissions` of the spec that uses it, an add-only
 * auth-service migration, and the tests that compare them. `self` is not a permission and is not
 * listed. Descriptions are compared only with the auth-service `permissions` table.
 */
export const PERMISSION_CATALOGUE = [
  {
    key: 'user:manage',
    description: "Create staff users and change a user's role, tenant or status.",
  },
  { key: 'user:read:any', description: 'View and list any user.' },
  { key: 'user:read:tenant', description: 'View and list the users of their own tenant.' },
  {
    key: 'role:manage',
    description: 'Create, edit and delete roles, and view the permission list.',
  },
  { key: 'operator:manage', description: 'List, onboard, edit and suspend operators.' },
  { key: 'operator:read:own', description: 'View their own operator record.' },
  { key: 'inventory:read', description: 'View venues, screens, routes and bus and coach layouts.' },
  { key: 'inventory:create', description: 'Create venues, screens, routes, layouts and trains.' },
  { key: 'inventory:update', description: 'Edit venues, screens, routes, layouts and trains.' },
  { key: 'inventory:delete', description: 'Delete venues, screens, routes, layouts and trains.' },
  { key: 'schedule:read', description: 'View schedules that are not published yet.' },
  { key: 'schedule:manage', description: 'Create, edit, delete and publish schedules.' },
  { key: 'schedule:cancel', description: 'Cancel a show or trip, which refunds its bookings.' },
  { key: 'movie:manage', description: 'Create, edit and delete movies.' },
  { key: 'station:manage', description: 'Create and edit stations.' },
  { key: 'policy:manage', description: 'Publish a new cancellation policy version.' },
  { key: 'fee:manage', description: 'Replace the convenience fee settings.' },
  { key: 'booking:read:any', description: 'View any booking.' },
  { key: 'booking:read:tenant', description: 'View the bookings of their own tenant.' },
  { key: 'booking:cancel:any', description: "Cancel a booking on a customer's behalf." },
  { key: 'refund:issue', description: 'Issue a goodwill refund up to the allowed limit.' },
  { key: 'refund:approve', description: 'Approve a refund above the allowed limit.' },
] as const satisfies readonly PermissionDefinition[];

/** The keys of the catalogue, in catalogue order. */
export const PERMISSION_KEYS = PERMISSION_CATALOGUE.map((definition) => definition.key);

/**
 * A key of the catalogue. Closed on purpose: a guard written with it rejects a typo at compile time.
 * Values read from a token or a request are plain strings; narrow them with `isPermissionKey` or
 * parse them with this schema.
 */
export const PermissionKey = z.enum(PERMISSION_KEYS);
export type PermissionKey = z.infer<typeof PermissionKey>;

const KNOWN_KEYS: ReadonlySet<unknown> = new Set(PERMISSION_KEYS);

/**
 * Tells whether a value is a key of this catalogue version.
 *
 * @param value - Anything, typically a string from a token claim or a request body.
 * @returns `true` when the value is one of the catalogue's keys.
 */
export function isPermissionKey(value: unknown): value is PermissionKey {
  return KNOWN_KEYS.has(value);
}
