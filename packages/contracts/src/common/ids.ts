import { z } from 'zod';

/** Opaque resource identifier. */
export const Id = z.uuid();
export type Id = z.infer<typeof Id>;
