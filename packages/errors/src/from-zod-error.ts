import { type FieldError } from '@ticketnest/contracts';
import { type z } from 'zod';

import { ValidationError } from './http-errors';

export type InputSource = 'body' | 'query' | 'path';

type ZodIssue = z.ZodError['issues'][number];

const MISSING_VALUE_SUFFIX = 'received undefined';
const FALLBACK_FIELD_ERROR: FieldError = {
  pointer: '#',
  code: 'INVALID_VALUE',
  detail: 'Invalid input.',
};

function escapePointerSegment(segment: PropertyKey): string {
  const text = typeof segment === 'symbol' ? (segment.description ?? '') : String(segment);
  return text.replaceAll('~', '~0').replaceAll('/', '~1');
}

function toPointer(path: readonly PropertyKey[], source: InputSource): string {
  const segments = path.map(escapePointerSegment);
  const prefix = source === 'body' ? [] : [source];
  return `#${[...prefix, ...segments].map((segment) => `/${segment}`).join('')}`;
}

/** Zod 4 has no `received` field, so a missing value is recognised by its message. A test pins it. */
function toCode(issue: ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return issue.message.endsWith(MISSING_VALUE_SUFFIX) ? 'REQUIRED' : 'INVALID_TYPE';
    case 'invalid_format':
      return 'INVALID_FORMAT';
    case 'too_small':
      return issue.origin === 'string' ? 'TOO_SHORT' : 'OUT_OF_RANGE';
    case 'too_big':
      return issue.origin === 'string' ? 'TOO_LONG' : 'OUT_OF_RANGE';
    default:
      return 'INVALID_VALUE';
  }
}

/** Converts a failed `schema.safeParse(...)` into a 422 listing every invalid field. */
export function fromZodError(error: z.ZodError, source: InputSource): ValidationError {
  const fieldErrors = error.issues.map((issue): FieldError => ({
    pointer: toPointer(issue.path, source),
    code: toCode(issue),
    detail: issue.message,
  }));
  const [first, ...rest] = fieldErrors;
  return new ValidationError([first ?? FALLBACK_FIELD_ERROR, ...rest], { cause: error });
}
