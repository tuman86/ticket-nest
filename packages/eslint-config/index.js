import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const ignores = ['**/dist/**', '**/.next/**', '**/.turbo/**', '**/coverage/**'];

/**
 * Base preset: TypeScript strict + stylistic, type-aware.
 * Use for packages that do not target a specific runtime (e.g. contracts).
 */
export const base = tseslint.config(
  { ignores },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    // Config and script files are not part of any tsconfig project.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);

/** Node preset: base plus Node globals. Use for services. */
export const node = tseslint.config(...base, {
  languageOptions: {
    globals: globals.node,
  },
});
