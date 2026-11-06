const HEADING_LINE = /^#{1,6}\s+(\S+)/;
const SEPARATOR_LINE = /^\|?[\s:|-]*-[\s:|-]*\|?$/;

/** One table of a Markdown document: its header cells and its rows keyed by header. */
export interface MarkdownTable {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, string>>[];
}

/**
 * Splits a table line into its trimmed cells.
 *
 * @param line - A line that starts with `|`.
 * @returns The cells between the pipes.
 * @throws Error when the line holds an escaped pipe (`\|`), which this reader does not support.
 */
function splitCells(line: string): string[] {
  if (line.includes('\\|')) {
    throw new Error(`The table reader does not support escaped pipes: ${line}`);
  }
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * Finds the lines of the section that starts at the heading with the given number and ends at the
 * next heading of any level.
 *
 * @param lines - The document, line by line.
 * @param sectionNumber - The first word of the heading text, such as `2.1` or `3.`.
 * @returns The lines between that heading and the next one.
 * @throws Error when no heading, or more than one, starts with that number.
 */
function findSection(lines: readonly string[], sectionNumber: string): string[] {
  const starts = lines.flatMap((line, index) =>
    HEADING_LINE.exec(line)?.[1] === sectionNumber ? [index] : [],
  );
  const [start] = starts;
  if (start === undefined) {
    throw new Error(`No heading numbered "${sectionNumber}" found in the document.`);
  }
  if (starts.length > 1) {
    throw new Error(
      `${String(starts.length)} headings are numbered "${sectionNumber}"; expected one.`,
    );
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => HEADING_LINE.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Reads the first table under a numbered heading of a Markdown document, so a test can compare a
 * documented list with code. It fails loudly instead of returning an empty table: a renamed heading,
 * a renamed column or a table with no rows throws, so a check built on it can never pass on zero rows.
 * Cells are returned as written (backticks and bold markers included).
 *
 * @param markdown - The text of the document.
 * @param sectionNumber - The first word of the section's heading text, such as `2.1` or `3.`. The
 *   section runs to the next heading of any level.
 * @param requiredColumns - Header cells the table must have, matched exactly after trimming.
 * @returns The table's columns and its rows, each keyed by column.
 * @throws Error when the heading is missing or ambiguous, the section has no table, the separator
 *   line is missing, a required column or a row cell is missing, a column name repeats, or the
 *   table has no rows.
 */
export function readMarkdownTable(
  markdown: string,
  sectionNumber: string,
  requiredColumns: readonly string[],
): MarkdownTable {
  const section = findSection(markdown.split('\n'), sectionNumber);
  const where = `section "${sectionNumber}"`;
  const headerIndex = section.findIndex((line) => line.trimStart().startsWith('|'));
  const headerLine = section[headerIndex];
  if (headerLine === undefined) throw new Error(`The ${where} has no table.`);

  const columns = splitCells(headerLine);
  if (new Set(columns).size !== columns.length) {
    throw new Error(`The table in ${where} repeats a column name: ${columns.join(', ')}.`);
  }
  const missing = requiredColumns.filter((column) => !columns.includes(column));
  if (missing.length > 0) {
    throw new Error(
      `The table in ${where} lacks column(s) ${missing.join(', ')}; it has ${columns.join(', ')}.`,
    );
  }
  if (!SEPARATOR_LINE.test(section[headerIndex + 1]?.trim() ?? '')) {
    throw new Error(`The table in ${where} has no separator line under its header.`);
  }

  const rows: Record<string, string>[] = [];
  for (const line of section.slice(headerIndex + 2)) {
    if (!line.trimStart().startsWith('|')) break;
    const cells = splitCells(line);
    if (cells.length !== columns.length) {
      throw new Error(
        `A row in ${where} has ${String(cells.length)} cells, expected ${String(columns.length)}: ${line}`,
      );
    }
    rows.push(Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? ''])));
  }
  if (rows.length === 0) throw new Error(`The table in ${where} has a header but no rows.`);
  return { columns, rows };
}
