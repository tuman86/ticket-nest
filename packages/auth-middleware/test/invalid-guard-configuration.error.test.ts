import { AppError, InternalServerError, toProblem } from '@ticketnest/errors';
import { describe, expect, it } from 'vitest';

import { InvalidGuardConfigurationError } from '@/invalid-guard-configuration.error';

describe('InvalidGuardConfigurationError', () => {
  it('is a 500 with its own code, so a log search finds a wrongly wired route', () => {
    const error = new InvalidGuardConfigurationError('inventory:creat');

    expect(error).toBeInstanceOf(InternalServerError);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      status: 500,
      code: 'INVALID_GUARD_CONFIGURATION',
      problemType: 'internal-error',
      name: 'InvalidGuardConfigurationError',
    });
  });

  it('names the offending key in its message, for the startup log', () => {
    const error = new InvalidGuardConfigurationError('inventory:creat');

    expect(error.message).toBe(
      'Unknown permission key `inventory:creat` in an access guard. Use a key of the permission catalogue.',
    );
  });

  it('never reaches a client with its detail, like every server error', () => {
    const problem = toProblem(new InvalidGuardConfigurationError('inventory:creat'));

    expect(problem).not.toHaveProperty('detail');
    expect(JSON.stringify(problem)).not.toContain('inventory:creat');
  });
});
