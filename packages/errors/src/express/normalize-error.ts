import { z } from 'zod';

import { AppError } from '../app-error';
import { BadRequestError, InternalServerError } from '../http-errors';
import { RequestRejectedError } from './request-rejected-error';

const MIN_CLIENT_STATUS = 400;
const MAX_CLIENT_STATUS = 499;
const BAD_REQUEST_STATUS = 400;
const JSON_PARSE_FAILED_TYPE = 'entity.parse.failed';

/** Shape of the `http-errors` that Express and body-parser raise for bad requests. */
const expressClientErrorSchema = z.object({
  status: z.int().min(MIN_CLIENT_STATUS).max(MAX_CLIENT_STATUS),
  type: z.string(),
});

/**
 * Turns anything thrown into an `AppError`. The message of a foreign error is never copied
 * into the result, because it can echo request content or name internals.
 */
export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const clientError = expressClientErrorSchema.safeParse(error);
  if (!clientError.success) {
    return new InternalServerError({ cause: error });
  }

  const { status, type } = clientError.data;
  if (type === JSON_PARSE_FAILED_TYPE) {
    return new BadRequestError({ detail: 'Request body is not valid JSON.', cause: error });
  }
  if (status === BAD_REQUEST_STATUS) {
    return new BadRequestError({ detail: 'Request could not be parsed.', cause: error });
  }
  return new RequestRejectedError(status, { cause: error });
}
