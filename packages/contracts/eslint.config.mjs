import { base } from '@ticketnest/eslint-config';

/**
 * `src/` is bundled for the browser by the Next apps, and `test/` holds Node-only helpers (the
 * `./testing` export). Nothing in `src/` may reach for either. The second tsconfig
 * (`tsconfig.src.json`, no Node types) catches Node APIs used without an import.
 */
const sourceMustNotImportTestCode = {
  files: ['src/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['node:*'],
            message: 'src/ is shared with browser apps. Node modules belong in test/ only.',
          },
          {
            group: ['**/test', '**/test/**', '@ticketnest/contracts/testing'],
            message: 'src/ must not import test code or the ./testing export.',
          },
        ],
      },
    ],
  },
};

export default [...base, sourceMustNotImportTestCode];
