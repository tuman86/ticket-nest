import { STATUS_CODES } from 'node:http';

import { AppError, type AppErrorOptions } from '../app-error';
import { PROBLEM_TYPE_SLUGS } from '../problem-types';

/** A 4xx raised by Express itself (e.g. 413 from the body parser) that has no dedicated class. */
export class RequestRejectedError extends AppError {
  constructor(status: number, options: AppErrorOptions = {}) {
    super(
      {
        status,
        code: 'REQUEST_REJECTED',
        title: STATUS_CODES[status] ?? 'Request rejected',
        problemType: PROBLEM_TYPE_SLUGS.requestRejected,
      },
      options,
    );
  }
}
