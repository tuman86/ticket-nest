import { z } from 'zod';

import { Id } from '../common/ids';
import { Timestamp } from '../common/time';

/** Longest email address allowed by RFC 5321. */
export const EMAIL_MAX_LENGTH = 254;
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;
export const NAME_MAX_LENGTH = 100;

/** Email address as typed. The service normalizes it before storing. */
export const Email = z.email().max(EMAIL_MAX_LENGTH);

/** Phone number in E.164 format. */
export const PhoneE164 = z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'must be in E.164 format');

/** Length rules only (no composition rules). The breached-password check lives in the service. */
export const Password = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

/** Body of `POST /v1/auth/register`. Strict: `role`, `tenantId` and the like are rejected. */
export const RegisterRequest = z.strictObject({
  email: Email,
  password: Password,
  name: z.string().trim().min(1).max(NAME_MAX_LENGTH),
  phone: PhoneE164.optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const RoleRef = z.object({
  id: Id,
  key: z.string(),
  name: z.string(),
});
export type RoleRef = z.infer<typeof RoleRef>;

export const UserStatus = z.enum(['ACTIVE', 'DISABLED']);
export type UserStatus = z.infer<typeof UserStatus>;

/**
 * The `User` returned by the API. A plain (non-strict) object on purpose: parsing a response
 * through it drops any field it does not list, so a password hash can never be serialized.
 */
export const UserResponse = z.object({
  id: Id,
  email: Email,
  emailVerified: z.boolean(),
  name: z.string(),
  phone: PhoneE164.nullable(),
  role: RoleRef,
  tenantId: Id.nullable(),
  status: UserStatus,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type UserResponse = z.infer<typeof UserResponse>;
