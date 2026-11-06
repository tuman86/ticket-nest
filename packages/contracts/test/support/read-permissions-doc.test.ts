import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parsePermissionsDocument, readPermissionsDocument } from './read-permissions-doc';

const REAL_DOCUMENT = readFileSync(
  path.resolve(import.meta.dirname, '../../../../docs/permissions.md'),
  'utf8',
);

const MINIMAL = `
### 2.1 Defined in a spec

| Key | Allows | Spec | Recent login |
|---|---|---|---|
| \`user:manage\` | Manage users | auth | Yes |
| \`movie:manage\` | Manage movies | catalog | |

### 2.2 Not yet

| Key | Allows | Recent login |
|---|---|---|
| \`refund:issue\` | Refund | Candidate |

## 3. Default roles

| Key | \`ADMIN\` |
|---|:-:|
| \`user:manage\` | ✓ |
`;

describe('parsePermissionsDocument', () => {
  it('reads the keys of the three sections', () => {
    expect(parsePermissionsDocument(MINIMAL)).toEqual({
      specified: [
        { key: 'user:manage', spec: 'auth' },
        { key: 'movie:manage', spec: 'catalog' },
      ],
      unspecified: ['refund:issue'],
      matrix: ['user:manage'],
      recentLogin: { 'user:manage': 'yes', 'movie:manage': 'no', 'refund:issue': 'candidate' },
    });
  });

  it('reads the real document into three non-empty lists', () => {
    const document = readPermissionsDocument();

    expect(document.specified.length).toBeGreaterThan(0);
    expect(document.unspecified.length).toBeGreaterThan(0);
    expect(document.matrix.length).toBeGreaterThan(0);
    expect(Object.values(document.recentLogin)).toContain('yes');
  });

  describe('a structure change in the real document throws, so no check can pass on zero rows', () => {
    it.each([
      [
        'a renamed section 2.1 heading',
        '### 2.1 Defined',
        '### 2.1x Defined',
        /No heading numbered "2\.1"/,
      ],
      [
        'a section 2.2 heading without its number',
        '### 2.2 Named',
        '### Named',
        /No heading numbered "2\.2"/,
      ],
      [
        'a section 3 heading without the dot',
        '## 3. Default roles',
        '## 3 Default roles',
        /No heading numbered "3\."/,
      ],
      ['a renamed Spec column', '| Spec |', '| Service |', /lacks column\(s\) Spec/],
      [
        'a renamed Key column',
        '| Key | Allows | Spec | Recent login |',
        '| Permission | Allows | Spec | Recent login |',
        /lacks column\(s\) Key/,
      ],
      [
        'a renamed Recent login column in section 2.1',
        '| Spec | Recent login |',
        '| Spec | Login |',
        /lacks column\(s\) Recent login/,
      ],
      [
        'a renamed Recent login column in section 2.2',
        '| Key | Allows | Recent login |',
        '| Key | Allows | Login |',
        /lacks column\(s\) Recent login/,
      ],
    ])('throws for %s', (_name, from, to, message) => {
      expect(REAL_DOCUMENT).toContain(from);
      expect(() => parsePermissionsDocument(REAL_DOCUMENT.replace(from, to))).toThrow(message);
    });

    it('throws when the default-roles matrix loses all its rows', () => {
      const [beforeMatrix = '', matrix = ''] = REAL_DOCUMENT.split('## 3. Default roles');
      const withoutRows = matrix
        .split('\n')
        .filter((line) => !line.startsWith('| `'))
        .join('\n');

      expect(() =>
        parsePermissionsDocument(`${beforeMatrix}## 3. Default roles${withoutRows}`),
      ).toThrow(/The table in section "3\." has a header but no rows/);
    });
  });

  it.each([
    [
      'a key without backticks',
      MINIMAL.replace('`user:manage` | Manage users', 'user:manage | Manage users'),
      /not a backticked permission key/,
    ],
    [
      'a key of the wrong shape',
      MINIMAL.replace('`movie:manage`', '`Movie:Manage`'),
      /not a backticked permission key/,
    ],
    [
      'a Spec other than auth or catalog',
      MINIMAL.replace('| catalog |', '| booking |'),
      /expected auth or catalog/,
    ],
    [
      'a Recent login mark other than Yes, Candidate or blank',
      MINIMAL.replace('| auth | Yes |', '| auth | Maybe |'),
      /expected Yes, Candidate or blank/,
    ],
    [
      'a key listed twice',
      MINIMAL.replace(
        '`movie:manage` | Manage movies | catalog',
        '`user:manage` | Manage movies | catalog',
      ),
      /more than once/,
    ],
  ])('throws for %s', (_name, document, message) => {
    expect(() => parsePermissionsDocument(document)).toThrow(message);
  });
});
