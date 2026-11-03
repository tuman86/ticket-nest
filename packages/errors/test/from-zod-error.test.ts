import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { fromZodError } from '@/from-zod-error';
import { ValidationError } from '@/http-errors';

const schema = z.object({
  email: z.email(),
  name: z.string().min(3).max(5),
  age: z.number().int().max(10),
  tags: z.array(z.string()).min(1),
  kind: z.enum(['movie', 'bus']),
  address: z.object({ city: z.string() }),
});

function failWith(input: unknown, source: 'body' | 'query' | 'path' = 'body'): ValidationError {
  const result = schema.safeParse(input);
  if (result.success) {
    throw new Error('expected the schema to reject the input');
  }
  return fromZodError(result.error, source);
}

describe('fromZodError', () => {
  it('returns a 422 ValidationError keeping the Zod error as cause', () => {
    const error = failWith({});

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.status).toBe(422);
    expect(error.cause).toBeInstanceOf(z.ZodError);
  });

  it('reports a missing field as REQUIRED with a JSON Pointer', () => {
    expect(failWith({}).fieldErrors).toContainEqual(
      expect.objectContaining({ pointer: '#/email', code: 'REQUIRED' }),
    );
  });

  it('maps each kind of failure to a spec code, listing all fields at once', () => {
    const codes = Object.fromEntries(
      failWith({
        email: 'nope',
        name: 'x',
        age: 99,
        tags: [],
        kind: 'train',
        address: { city: 5 },
      }).fieldErrors.map((fieldError) => [fieldError.pointer, fieldError.code]),
    );

    expect(codes).toEqual({
      '#/email': 'INVALID_FORMAT',
      '#/name': 'TOO_SHORT',
      '#/age': 'OUT_OF_RANGE',
      '#/tags': 'OUT_OF_RANGE',
      '#/kind': 'INVALID_VALUE',
      '#/address/city': 'INVALID_TYPE',
    });
  });

  it('maps too-long strings to TOO_LONG', () => {
    const valid = { email: 'a@b.test', age: 1, tags: ['t'], kind: 'bus', address: { city: 'x' } };

    expect(failWith({ ...valid, name: 'toolongname' }).fieldErrors).toEqual([
      expect.objectContaining({ pointer: '#/name', code: 'TOO_LONG' }),
    ]);
  });

  it('prefixes pointers with the input source for query and path', () => {
    expect(failWith({}, 'query').fieldErrors[0]?.pointer).toBe('#/query/email');
    expect(failWith({}, 'path').fieldErrors[0]?.pointer).toBe('#/path/email');
  });

  it('escapes ~ and / in pointer segments (RFC 6901)', () => {
    const result = z.object({ 'a/b~c': z.string() }).safeParse({});
    if (result.success) {
      throw new Error('expected failure');
    }

    expect(fromZodError(result.error, 'body').fieldErrors[0]?.pointer).toBe('#/a~1b~0c');
  });

  it('points at the root when the whole input is wrong', () => {
    const result = z.string().safeParse(5);
    if (result.success) {
      throw new Error('expected failure');
    }

    expect(fromZodError(result.error, 'body').fieldErrors[0]?.pointer).toBe('#');
  });
});
