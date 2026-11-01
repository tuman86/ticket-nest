import { z } from 'zod';

/** Amount in the smallest currency unit (cents for USD). Never a float. */
export const Money = z.object({
  amountMinor: z.int().nonnegative(),
  currency: z.literal('USD'),
});
export type Money = z.infer<typeof Money>;
