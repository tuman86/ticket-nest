import { z } from 'zod';

/** One invalid field in a `ValidationProblem`. */
export const FieldError = z.object({
  pointer: z.string(),
  code: z.string(),
  detail: z.string(),
});
export type FieldError = z.infer<typeof FieldError>;

/** RFC 9457 problem details (`application/problem+json`). Extensions are allowed. */
export const Problem = z.looseObject({
  type: z.url(),
  title: z.string(),
  status: z.int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string().optional(),
  correlationId: z.string().optional(),
});
export type Problem = z.infer<typeof Problem>;

/** Problem with per-field validation details (HTTP 422). */
export const ValidationProblem = Problem.extend({
  errors: z.array(FieldError).min(1),
});
export type ValidationProblem = z.infer<typeof ValidationProblem>;
