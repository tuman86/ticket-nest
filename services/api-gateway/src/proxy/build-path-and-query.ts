const QUERY_SEPARATOR = '?';

/**
 * Builds the path and query string sent to a service. The path is the one route resolution
 * validated; only the query is taken from the raw URL, since the validated path may differ from it
 * (for example in how it is encoded).
 *
 * @param request - The request's validated path and its raw URL.
 * @returns The path, followed by the query string (with its `?`) when there is one.
 */
export function buildPathAndQuery(request: {
  readonly path: string;
  readonly originalUrl: string;
}): string {
  const queryStart = request.originalUrl.indexOf(QUERY_SEPARATOR);
  return queryStart === -1 ? request.path : request.path + request.originalUrl.slice(queryStart);
}
