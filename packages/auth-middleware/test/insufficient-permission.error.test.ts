import { ForbiddenError, toProblem } from '@ticketnest/errors';
import { describe, expect, it } from 'vitest';

import { type AccessRefusalReason } from '@/access-scope';
import { InsufficientPermissionError } from '@/insufficient-permission.error';

const REFUSAL_REASONS: readonly AccessRefusalReason[] = [
  'missing_permission',
  'tenant_key_without_tenant',
  'own_key_without_tenant',
  'platform_only_with_tenant',
  'unsupported_key_scope',
];

describe('InsufficientPermissionError', () => {
  it('is a 403 Forbidden like any other refusal of an authenticated caller', () => {
    const error = new InsufficientPermissionError(['inventory:create'], 'missing_permission');

    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      problemType: 'forbidden',
      name: 'InsufficientPermissionError',
    });
  });

  it('names the one required key, as common.yaml shows', () => {
    const error = new InsufficientPermissionError(['inventory:create'], 'missing_permission');

    expect(error.detail).toBe('Missing permission `inventory:create`.');
    expect(error.message).toBe('Missing permission `inventory:create`.');
  });

  it('names every accepted key, in route order, when the route is any-of', () => {
    const error = new InsufficientPermissionError(
      ['role:manage', 'user:manage'],
      'missing_permission',
    );

    expect(error.detail).toBe('Missing one of the permissions `role:manage`, `user:manage`.');
  });

  it('carries the reason for the log', () => {
    const error = new InsufficientPermissionError(
      ['user:read:tenant'],
      'tenant_key_without_tenant',
    );

    expect(error.reason).toBe('tenant_key_without_tenant');
  });

  it.each(REFUSAL_REASONS)(
    'answers %s with the same body, so the response never says why',
    (reason) => {
      const required = ['user:read:any', 'user:read:tenant'] as const;
      const refused = toProblem(new InsufficientPermissionError(required, reason));
      const missing = toProblem(new InsufficientPermissionError(required, 'missing_permission'));

      expect(refused).toEqual(missing);
      expect(Object.keys(refused).sort()).toEqual(['code', 'detail', 'status', 'title', 'type']);
    },
  );
});
