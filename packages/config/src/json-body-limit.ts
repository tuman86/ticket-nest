import { z } from 'zod';

const DEFAULT_JSON_BODY_LIMIT = '100kb';
/** A whole number and a unit (`b`, `kb` or `mb`, any case): the sizes Express's JSON parser reads. */
const BODY_LIMIT_PATTERN = /^\d+(b|kb|mb)$/i;

/**
 * `JSON_BODY_LIMIT`: the largest JSON request body a service parses, for example `100kb`. Larger
 * bodies are refused with 413 before any work is done. Default `100kb`.
 */
export const jsonBodyLimitSchema = z
  .string()
  .regex(BODY_LIMIT_PATTERN)
  .default(DEFAULT_JSON_BODY_LIMIT);
