import { z } from 'zod';

/** Cursor pagination query parameters (`limit` + `cursor`). */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(512).optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

/** Pagination metadata returned with every list response. */
export const PageInfo = z.object({
  limit: z.int().positive(),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type PageInfo = z.infer<typeof PageInfo>;

/** Builds the `{ data, page }` envelope for a list of `item`. */
export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item),
    page: PageInfo,
  });
