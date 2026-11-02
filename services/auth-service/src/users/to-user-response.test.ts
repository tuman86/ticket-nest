import { UserResponse } from '@ticketnest/contracts';
import { describe, expect, it } from 'vitest';

import { type UserRecord } from '../repositories/user.repository';

import { toUserResponse } from './to-user-response';

const record: UserRecord = {
  id: '4b0d2f0e-8f0c-4d0e-9a6f-0c2f6a5d1e11',
  email: 'asha@example.com',
  emailVerifiedAt: null,
  passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
  name: 'Asha Rao',
  phone: null,
  roleId: '7c1a9b52-1c47-4e0a-8a3b-6d3e1f0b2a10',
  tenantId: null,
  status: 'ACTIVE',
  createdAt: new Date('2026-11-01T10:00:00.000Z'),
  updatedAt: new Date('2026-11-01T10:05:00.000Z'),
};
const role = { id: record.roleId, key: 'CUSTOMER', name: 'Customer' };

describe('toUserResponse', () => {
  it('maps a stored user to the API shape', () => {
    expect(toUserResponse(record, role)).toEqual({
      id: record.id,
      email: 'asha@example.com',
      emailVerified: false,
      name: 'Asha Rao',
      phone: null,
      role,
      tenantId: null,
      status: 'ACTIVE',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:05:00.000Z',
    });
  });

  it('marks the email verified once a verification time exists', () => {
    const verified = { ...record, emailVerifiedAt: new Date('2026-11-02T00:00:00.000Z') };

    expect(toUserResponse(verified, role).emailVerified).toBe(true);
  });

  it('never carries the password hash or the role id column', () => {
    const response = toUserResponse(record, role);

    expect(response).not.toHaveProperty('passwordHash');
    expect(response).not.toHaveProperty('roleId');
    expect(JSON.stringify(response)).not.toContain('argon2');
    expect(UserResponse.safeParse(response).success).toBe(true);
  });
});
