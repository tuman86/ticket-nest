import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseGrantMatrix, readGrantMatrix } from './read-grant-matrix';

const REAL_DOCUMENT = readFileSync(
  path.resolve(import.meta.dirname, '../../../../docs/permissions.md'),
  'utf8',
);

const MINIMAL = `
## 3. Default roles

| Key | \`CUSTOMER\` | \`OPERATOR\` | \`ADMIN\` |
|---|:-:|:-:|:-:|
| \`user:manage\` | | | ✓ |
| \`user:read:tenant\` | | ✓* | ✓ |
| \`schedule:cancel\` | | ✓ (own tenant) | ✓ |
| \`station:manage\` | | | ✓* |
`;

describe('parseGrantMatrix', () => {
  it('reads the role columns in document order', () => {
    expect(parseGrantMatrix(MINIMAL).roleKeys).toEqual(['CUSTOMER', 'OPERATOR', 'ADMIN']);
  });

  it('reads ✓ as confirmed, ✓* as assumed and a blank cell as no grant', () => {
    const matrix = parseGrantMatrix(MINIMAL);

    expect(matrix.confirmed).toEqual({
      CUSTOMER: [],
      OPERATOR: ['schedule:cancel'],
      ADMIN: ['user:manage', 'user:read:tenant', 'schedule:cancel'],
    });
    expect(matrix.assumed).toEqual({
      CUSTOMER: [],
      OPERATOR: ['user:read:tenant'],
      ADMIN: ['station:manage'],
    });
  });

  it('accepts a note in parentheses after ✓ and still counts it as confirmed', () => {
    expect(parseGrantMatrix(MINIMAL).confirmed.OPERATOR).toContain('schedule:cancel');
  });

  it('never lists a key as both confirmed and assumed for one role', () => {
    const { confirmed, assumed, roleKeys } = parseGrantMatrix(MINIMAL);

    for (const role of roleKeys) {
      const both = (confirmed[role] ?? []).filter((key) => (assumed[role] ?? []).includes(key));
      expect(both, role).toEqual([]);
    }
  });

  describe('anything it does not understand throws, so a typo cannot silently become no grant', () => {
    it.each([
      ['a word instead of a tick', '| `user:manage` | | | ✓ |', '| `user:manage` | | | yes |'],
      ['a cross', '| `user:manage` | | | ✓ |', '| `user:manage` | | | ✗ |'],
      ['two ticks', '| `user:manage` | | | ✓ |', '| `user:manage` | | | ✓✓ |'],
      ['a star without a tick', '| `user:manage` | | | ✓ |', '| `user:manage` | | | * |'],
      [
        'a note without a tick',
        '| `user:manage` | | | ✓ |',
        '| `user:manage` | | | (own tenant) |',
      ],
      [
        'a note on an assumed grant',
        '| `user:read:tenant` | | ✓* | ✓ |',
        '| `user:read:tenant` | | ✓* (maybe) | ✓ |',
      ],
      ['an unclosed note', '| `user:manage` | | | ✓ |', '| `user:manage` | | | ✓ (own |'],
      ['a dash', '| `user:manage` | | | ✓ |', '| `user:manage` | | | - |'],
    ])('throws for %s', (_name, from, to) => {
      expect(MINIMAL).toContain(from);
      expect(() => parseGrantMatrix(MINIMAL.replace(from, to))).toThrow(
        /user:(manage|read:tenant).*(is "|expected)/s,
      );
    });

    it('names the key, the role and the cell in the message', () => {
      const broken = MINIMAL.replace('| `user:manage` | | | ✓ |', '| `user:manage` | | | yes |');

      expect(() => parseGrantMatrix(broken)).toThrow(
        'Section "3.": the grant of user:manage for ADMIN is "yes", expected ✓, ✓ (note), ✓* or blank.',
      );
    });

    it('throws for a role column that is not a backticked role key', () => {
      const broken = MINIMAL.replace('`OPERATOR`', 'OPERATOR');

      expect(() => parseGrantMatrix(broken)).toThrow(/"OPERATOR" is not a backticked role key/);
    });

    it('throws for a role column in lower case', () => {
      expect(() => parseGrantMatrix(MINIMAL.replace('`OPERATOR`', '`operator`'))).toThrow(
        /not a backticked role key/,
      );
    });

    it('throws when the table has no role column at all', () => {
      const onlyKeys = '## 3. Default roles\n\n| Key |\n|---|\n| `user:manage` |\n';

      expect(() => parseGrantMatrix(onlyKeys)).toThrow(/no role columns/);
    });

    it('throws for a key cell without backticks', () => {
      const broken = MINIMAL.replace('| `user:manage` |', '| user:manage |');

      expect(() => parseGrantMatrix(broken)).toThrow(/not a backticked permission key/);
    });

    it('throws for a key listed twice', () => {
      const broken = MINIMAL.replace('| `station:manage` |', '| `user:manage` |');

      expect(() => parseGrantMatrix(broken)).toThrow(/more than once/);
    });

    it('throws when the heading, the Key column or all the rows are missing', () => {
      expect(() => parseGrantMatrix(MINIMAL.replace('## 3. Default', '## 3 Default'))).toThrow(
        /No heading numbered "3\."/,
      );
      expect(() => parseGrantMatrix(MINIMAL.replace('| Key |', '| Permission |'))).toThrow(
        /lacks column\(s\) Key/,
      );
      const withoutRows = MINIMAL.split('\n')
        .filter((line) => !line.startsWith('| `'))
        .join('\n');
      expect(() => parseGrantMatrix(withoutRows)).toThrow(/header but no rows/);
    });
  });

  describe('the real docs/permissions.md', () => {
    const matrix = parseGrantMatrix(REAL_DOCUMENT);

    it('has the four built-in roles', () => {
      expect(matrix.roleKeys).toEqual(['CUSTOMER', 'OPERATOR', 'SUPPORT_AGENT', 'ADMIN']);
    });

    it('reads the grants ADR-0025 section 3 describes', () => {
      expect(matrix.confirmed.CUSTOMER).toEqual([]);
      expect(matrix.assumed.CUSTOMER).toEqual([]);
      expect(matrix.confirmed.OPERATOR).toContain('schedule:cancel');
      expect([...(matrix.assumed.OPERATOR ?? [])].sort()).toEqual([
        'booking:read:tenant',
        'user:read:tenant',
      ]);
      expect([...(matrix.confirmed.SUPPORT_AGENT ?? [])].sort()).toEqual([
        'booking:read:any',
        'refund:issue',
      ]);
      expect([...(matrix.assumed.SUPPORT_AGENT ?? [])].sort()).toEqual([
        'booking:cancel:any',
        'user:read:any',
      ]);
      expect(matrix.assumed.ADMIN).toEqual(['station:manage']);
    });

    it('is what readGrantMatrix returns from the repository', () => {
      expect(readGrantMatrix()).toEqual(matrix);
    });
  });
});
