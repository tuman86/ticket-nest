import { ROUTE_TABLE, type RouteEntry } from './route-table';

const PATH_SEPARATOR = '/';
const LAST_C0_CONTROL_CODE = 0x1f;
const DELETE_CODE = 0x7f;

/**
 * @param text - Decoded text from one path segment.
 * @returns True when it holds a control character (NUL, CR, LF, DEL...).
 */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= LAST_C0_CONTROL_CODE || code === DELETE_CODE) {
      return true;
    }
  }
  return false;
}

/**
 * Tells whether a request path is safe to forward as is. The gateway sends the path to the
 * service unchanged, so a segment that the service (or a proxy in between) could read as
 * something else is refused: `.` and `..`, an encoded slash or backslash, a control character,
 * or a percent sequence that does not decode.
 *
 * @param path - The path from the request line, without the query string.
 * @returns True when every segment is a plain name.
 */
export function isSafePath(path: string): boolean {
  return path.split(PATH_SEPARATOR).every((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    return (
      decoded !== '.' &&
      decoded !== '..' &&
      !decoded.includes(PATH_SEPARATOR) &&
      !decoded.includes('\\') &&
      !hasControlCharacter(decoded)
    );
  });
}

/**
 * @param path - The request path.
 * @param entry - A route table entry.
 * @returns True when the path is the prefix itself or lies below it. `/v1/authentic` does not
 *   match `/v1/auth`, because prefixes match whole segments.
 */
function isUnderPrefix(path: string, entry: RouteEntry): boolean {
  return path === entry.prefix || path.startsWith(`${entry.prefix}${PATH_SEPARATOR}`);
}

/**
 * Finds the service that owns a path. The longest matching prefix wins, so a more specific entry
 * can later carve a path out of a broader one.
 *
 * @param path - The request path, without the query string.
 * @param table - The route table. Defaults to the production one.
 * @returns The matching entry, or `undefined` when no service owns the path.
 */
export function resolveRoute(
  path: string,
  table: readonly RouteEntry[] = ROUTE_TABLE,
): RouteEntry | undefined {
  let best: RouteEntry | undefined;
  for (const entry of table) {
    const isLonger = best === undefined || entry.prefix.length > best.prefix.length;
    if (isUnderPrefix(path, entry) && isLonger) {
      best = entry;
    }
  }
  return best;
}
