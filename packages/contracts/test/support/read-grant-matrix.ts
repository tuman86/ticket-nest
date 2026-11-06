import { readFileSync } from 'node:fs';

import { readMarkdownTable } from './read-markdown-table';
import { PERMISSIONS_DOC, readKeys } from './read-permissions-doc';

const SECTION_NUMBER = '3.';
const KEY_COLUMN = 'Key';
/** A role column header: the role key in backticks, such as `` `SUPPORT_AGENT` ``. */
const ROLE_HEADER = /^`([A-Z][A-Z_]*)`$/;
/** ✓, optionally followed by a note in parentheses (`✓ (own tenant)`): a confirmed grant. */
const CONFIRMED_CELL = /^✓(?: \([^()]+\))?$/;
/** ✓* alone: a grant the owner has not confirmed (ADR-0025 seeds it for `ADMIN` only). */
const ASSUMED_CELL = '✓*';

/** What `docs/permissions.md` section 3 grants each role, split by how sure the document is. */
export interface GrantMatrix {
  /** The role columns, in document order. */
  readonly roleKeys: readonly string[];
  /** Per role, the keys marked ✓ (a note after the tick is allowed), in document order. */
  readonly confirmed: Readonly<Record<string, readonly string[]>>;
  /** Per role, the keys marked ✓*, in document order. A blank cell is neither list. */
  readonly assumed: Readonly<Record<string, readonly string[]>>;
}

/**
 * Reads the role key out of a column header.
 *
 * @param column - A header cell of the section 3 table other than `Key`.
 * @returns The role key without its backticks.
 * @throws Error when the header is not a backticked upper-case role key.
 */
function readRoleKey(column: string): string {
  const roleKey = ROLE_HEADER.exec(column)?.[1];
  if (roleKey === undefined) {
    throw new Error(
      `Section "${SECTION_NUMBER}": the column "${column}" is not a backticked role key.`,
    );
  }
  return roleKey;
}

/**
 * Reads the default-role grants of the permission catalogue document. It fails loudly on a cell it
 * does not understand, so a typo can never turn into "no grant" and let a seeded role drift from the
 * document unseen.
 *
 * @param markdown - The text of `docs/permissions.md`.
 * @returns For each role, its confirmed and its assumed keys.
 * @throws Error when the section, the `Key` column or the rows are missing (see `readMarkdownTable`),
 *   a key is not a backticked permission key or repeats, a column header is not a backticked role
 *   key, there is no role column, or a cell is not ✓, ✓ with a parenthesised note, ✓* or blank.
 */
export function parseGrantMatrix(markdown: string): GrantMatrix {
  const table = readMarkdownTable(markdown, SECTION_NUMBER, [KEY_COLUMN]);
  const roleKeys = table.columns.filter((column) => column !== KEY_COLUMN).map(readRoleKey);
  if (roleKeys.length === 0) {
    throw new Error(`Section "${SECTION_NUMBER}": the table has no role columns.`);
  }
  const keys = readKeys(table, SECTION_NUMBER);
  const confirmed: Record<string, string[]> = Object.fromEntries(
    roleKeys.map((role) => [role, []]),
  );
  const assumed: Record<string, string[]> = Object.fromEntries(roleKeys.map((role) => [role, []]));

  table.rows.forEach((row, index) => {
    const key = keys[index] ?? '';
    for (const role of roleKeys) {
      const cell = row[`\`${role}\``] ?? '';
      if (CONFIRMED_CELL.test(cell)) {
        confirmed[role]?.push(key);
      } else if (cell === ASSUMED_CELL) {
        assumed[role]?.push(key);
      } else if (cell !== '') {
        throw new Error(
          `Section "${SECTION_NUMBER}": the grant of ${key} for ${role} is "${cell}", expected ✓, ✓ (note), ✓* or blank.`,
        );
      }
    }
  });
  return { roleKeys, confirmed, assumed };
}

/**
 * Reads the default-role grants from `docs/permissions.md` in the repository.
 *
 * @returns For each role, its confirmed and its assumed keys.
 * @throws Error as `parseGrantMatrix` does.
 */
export function readGrantMatrix(): GrantMatrix {
  return parseGrantMatrix(readFileSync(PERMISSIONS_DOC, 'utf8'));
}
