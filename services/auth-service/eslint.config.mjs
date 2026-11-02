import { node } from '@ticketnest/eslint-config';

// `src/generated` is Prisma client output (git-ignored); it is not ours to lint.
export default [{ ignores: ['src/generated/**'] }, ...node];
