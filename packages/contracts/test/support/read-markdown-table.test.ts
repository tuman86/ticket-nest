import { describe, expect, it } from 'vitest';

import { readMarkdownTable } from './read-markdown-table';

const DOCUMENT = `# Title

Some text with a | pipe that is not a table.

## 1. First

| Key | Note |
|---|---|
| \`a\` | first |
| \`b\` | second |

Text after the table.

| Other | Table |
|---|---|
| ignored | ignored |

### 1.1 Nested

| Key | Spec |
|:-|:-:|
| \`c\` | auth |

## 2. Empty

| Key |
|---|

## 3. No table here

Only prose.
`;

describe('readMarkdownTable', () => {
  it('reads the rows of the first table under the heading, keyed by column', () => {
    expect(readMarkdownTable(DOCUMENT, '1.', ['Key', 'Note'])).toEqual({
      columns: ['Key', 'Note'],
      rows: [
        { Key: '`a`', Note: 'first' },
        { Key: '`b`', Note: 'second' },
      ],
    });
  });

  it('ends a section at the next heading of any level, so a nested table is not mixed in', () => {
    const nested = readMarkdownTable(DOCUMENT, '1.1', ['Key', 'Spec']);

    expect(nested.rows).toEqual([{ Key: '`c`', Spec: 'auth' }]);
  });

  it('accepts a table whose rows lack the outer pipes', () => {
    const table = readMarkdownTable('## 1. T\n\n| A | B\n|---|---\n| x | y\n', '1.', ['A']);

    expect(table.rows).toEqual([{ A: 'x', B: 'y' }]);
  });

  describe('fails loudly instead of returning nothing', () => {
    it.each([
      ['a missing heading', '9.', ['Key'], /No heading numbered "9\."/],
      ['a section without a table', '3.', ['Key'], /has no table/],
      ['a missing column', '1.', ['Key', 'Spec'], /lacks column\(s\) Spec; it has Key, Note/],
      ['a table with a header and no rows', '2.', ['Key'], /header but no rows/],
    ])('throws for %s', (_name, section, columns, message) => {
      expect(() => readMarkdownTable(DOCUMENT, section, columns)).toThrow(message);
    });

    it('throws when two headings carry the same number', () => {
      const document = '## 1. A\n\n| K |\n|---|\n| x |\n\n## 1. B\n';

      expect(() => readMarkdownTable(document, '1.', ['K'])).toThrow(/2 headings are numbered/);
    });

    it('throws when the heading was reworded so its number no longer matches', () => {
      expect(() =>
        readMarkdownTable(DOCUMENT.replace('## 1. First', '## 1 First'), '1.', ['Key']),
      ).toThrow(/No heading numbered/);
    });

    it('throws for a header without the separator line', () => {
      const document = '## 1. T\n\n| K |\n| x |\n';

      expect(() => readMarkdownTable(document, '1.', ['K'])).toThrow(/no separator line/);
    });

    it('throws for a row with the wrong number of cells', () => {
      const document = '## 1. T\n\n| K | V |\n|---|---|\n| x |\n';

      expect(() => readMarkdownTable(document, '1.', ['K'])).toThrow(/has 1 cells, expected 2/);
    });

    it('throws for a repeated column name and for an escaped pipe', () => {
      expect(() =>
        readMarkdownTable('## 1. T\n\n| K | K |\n|---|---|\n| a | b |\n', '1.', ['K']),
      ).toThrow(/repeats a column name/);
      expect(() =>
        readMarkdownTable('## 1. T\n\n| K |\n|---|\n| a \\| b |\n', '1.', ['K']),
      ).toThrow(/escaped pipes/);
    });
  });
});
