import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname);
const CODE_FILE_PATTERN = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const ESLINT_CONFIG_NAMES = ['eslint.config.mjs', 'eslint.config.js', 'eslint.config.ts'];

/** Quote a path for the shell that lint-staged spawns. */
const quote = (filePath) => `'${filePath.replaceAll("'", "'\\''")}'`;

/**
 * Nearest ancestor directory (below the repo root) that has both a
 * package.json and an eslint config. ESLint is type-aware and uses
 * process.cwd() as its tsconfig root, so it must run from that directory.
 */
function findEslintWorkspace(filePath) {
  let directory = dirname(filePath);
  while (directory.startsWith(repositoryRoot + sep)) {
    const hasPackage = existsSync(join(directory, 'package.json'));
    const hasEslintConfig = ESLINT_CONFIG_NAMES.some((name) => existsSync(join(directory, name)));
    if (hasPackage && hasEslintConfig) return directory;
    directory = dirname(directory);
  }
  return undefined;
}

function buildEslintCommands(codeFiles) {
  const filesByWorkspace = new Map();
  for (const filePath of codeFiles) {
    const workspace = findEslintWorkspace(filePath);
    if (!workspace) continue; // root scripts and config files have no ESLint config
    filesByWorkspace.set(workspace, [...(filesByWorkspace.get(workspace) ?? []), filePath]);
  }
  return [...filesByWorkspace].map(
    ([workspace, files]) =>
      `pnpm --dir ${quote(relative(repositoryRoot, workspace))} exec eslint --fix --no-warn-ignored --max-warnings 0 ${files.map(quote).join(' ')}`,
  );
}

// One entry for every staged file, so no file is matched (and rewritten) by two tasks at once.
// lint-staged runs the commands returned here one after another.
export default {
  '*': (stagedFiles) => {
    const codeFiles = stagedFiles.filter((filePath) => CODE_FILE_PATTERN.test(filePath));
    return [
      // ESLint fixes first, then Prettier has the last word on formatting.
      ...buildEslintCommands(codeFiles),
      // Ignored paths (docs/, pnpm-lock.yaml) are skipped through .prettierignore.
      `prettier --write --ignore-unknown ${stagedFiles.map(quote).join(' ')}`,
    ];
  },
};
