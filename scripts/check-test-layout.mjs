// Fails when a workspace breaks the test layout in .claude/rules/testing.md:
//   - no test files or `test-support` folders under src/
//   - services keep tests in test/unit or test/integration (helpers in test/support)
//   - no `.integration.test.ts` suffix (the folder says which kind a test is)
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const repositoryRoot = join(import.meta.dirname, '..');
const WORKSPACE_PARENTS = ['apps', 'services', 'packages'];
const TEST_FILE_PATTERN = /\.(test|spec)\.tsx?$/;
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', '.next', '.turbo', 'generated']);
const SERVICE_TEST_FOLDERS = ['unit', 'integration'];

/** @returns {string[]} Absolute paths of every workspace folder. */
function listWorkspaces() {
  return WORKSPACE_PARENTS.flatMap((parent) => {
    const parentPath = join(repositoryRoot, parent);
    if (!existsSync(parentPath)) return [];
    return readdirSync(parentPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parentPath, entry.name));
  });
}

/**
 * @param {string} folder Absolute folder path.
 * @returns {string[]} Paths of every file and folder below it (relative to it), skipping build output.
 */
function listEntries(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { recursive: true }).filter(
    (entry) => !entry.split(sep).some((part) => SKIPPED_FOLDERS.has(part)),
  );
}

/**
 * @param {string} workspace Absolute workspace path.
 * @returns {string[]} Human-readable violations found in the workspace.
 */
function checkWorkspace(workspace) {
  const violations = [];
  const isService = relative(repositoryRoot, workspace).startsWith(`services${sep}`);
  const show = (path) => relative(repositoryRoot, path);

  for (const entry of listEntries(join(workspace, 'src'))) {
    const isMisplaced = TEST_FILE_PATTERN.test(entry) || entry.split(sep).includes('test-support');
    if (isMisplaced) {
      violations.push(
        `${show(join(workspace, 'src', entry))}: tests and test helpers belong in test/`,
      );
    }
  }
  for (const entry of listEntries(join(workspace, 'test'))) {
    if (!TEST_FILE_PATTERN.test(entry)) continue;
    const path = show(join(workspace, 'test', entry));
    if (/\.integration\.(test|spec)\./.test(entry)) {
      violations.push(`${path}: drop the .integration suffix, put the file in test/integration/`);
    }
    if (isService && !SERVICE_TEST_FOLDERS.includes(entry.split(sep)[0])) {
      violations.push(`${path}: service tests go in test/unit/ or test/integration/`);
    }
  }
  return violations;
}

const violations = listWorkspaces().flatMap(checkWorkspace);
if (violations.length > 0) {
  console.error(
    `Test layout violations (see .claude/rules/testing.md):\n  ${violations.join('\n  ')}`,
  );
  process.exit(1);
}
