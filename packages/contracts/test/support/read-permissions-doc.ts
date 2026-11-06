import { readFileSync } from 'node:fs';
import path from 'node:path';

import { type MarkdownTable, readMarkdownTable } from './read-markdown-table';

const PERMISSIONS_DOC = path.resolve(import.meta.dirname, '../../../../docs/permissions.md');
/** Shape of a permission key, written out here on purpose: the doc is checked against the code, not derived from it. */
const BACKTICKED_KEY = /^`([a-z_]+:[a-z_]+(?::[a-z_]+)?)`$/;
const DOCUMENTED_SPECS = ['auth', 'catalog'] as const;

/** The spec a section 2.1 key names in its `Spec` column. */
export type DocumentedSpec = (typeof DOCUMENTED_SPECS)[number];

/** What `docs/permissions.md` says, reduced to the keys. Grants and prose are not read. */
export interface PermissionsDocument {
  /** Section 2.1: keys defined in an OpenAPI spec, with the spec the doc names. */
  readonly specified: readonly { readonly key: string; readonly spec: DocumentedSpec }[];
  /** Section 2.2: keys named in the PRD whose spec is not written yet. */
  readonly unspecified: readonly string[];
  /** Section 3: the keys that have a row in the default-roles matrix. */
  readonly matrix: readonly string[];
}

/**
 * Reads the keys out of a table's `Key` column.
 *
 * @param table - A table that has a `Key` column.
 * @param sectionNumber - The section's number, for error messages.
 * @returns The keys in table order, without their backticks.
 * @throws Error when a key cell is not a backticked key, or a key appears twice.
 */
function readKeys(table: MarkdownTable, sectionNumber: string): string[] {
  const keys = table.rows.map((row) => {
    const cell = row.Key ?? '';
    const key = BACKTICKED_KEY.exec(cell)?.[1];
    if (key === undefined) {
      throw new Error(`Section "${sectionNumber}": "${cell}" is not a backticked permission key.`);
    }
    return key;
  });
  const repeated = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (repeated.length > 0) {
    throw new Error(`Section "${sectionNumber}" lists ${repeated.join(', ')} more than once.`);
  }
  return keys;
}

/**
 * Narrows a `Spec` cell to a spec name.
 *
 * @param cell - The cell text.
 * @param key - The row's key, for the error message.
 * @returns The spec the cell names.
 * @throws Error when the cell is neither `auth` nor `catalog`.
 */
function parseDocumentedSpec(cell: string, key: string): DocumentedSpec {
  const spec = DOCUMENTED_SPECS.find((candidate) => candidate === cell);
  if (spec === undefined) {
    throw new Error(`Section "2.1": the Spec of ${key} is "${cell}", expected auth or catalog.`);
  }
  return spec;
}

/**
 * Reads the keys of sections 2.1, 2.2 and 3 of the permission catalogue document.
 *
 * @param markdown - The text of `docs/permissions.md`.
 * @returns The documented keys. Never empty: every table must have rows.
 * @throws Error when a heading, a column or a table is missing or empty, or a cell is malformed
 *   (see `readMarkdownTable`), so a restructured document fails every check that reads it.
 */
export function parsePermissionsDocument(markdown: string): PermissionsDocument {
  const specifiedTable = readMarkdownTable(markdown, '2.1', ['Key', 'Spec']);
  const specifiedKeys = readKeys(specifiedTable, '2.1');
  return {
    specified: specifiedTable.rows.map((row, index) => {
      const key = specifiedKeys[index] ?? '';
      return { key, spec: parseDocumentedSpec(row.Spec ?? '', key) };
    }),
    unspecified: readKeys(readMarkdownTable(markdown, '2.2', ['Key']), '2.2'),
    matrix: readKeys(readMarkdownTable(markdown, '3.', ['Key']), '3.'),
  };
}

/**
 * Reads `docs/permissions.md` from the repository.
 *
 * @returns The documented keys.
 */
export function readPermissionsDocument(): PermissionsDocument {
  return parsePermissionsDocument(readFileSync(PERMISSIONS_DOC, 'utf8'));
}
