import { z } from 'zod';

/** RFC 3339 timestamp in UTC (must end in `Z`). */
export const Timestamp = z.iso.datetime();
export type Timestamp = z.infer<typeof Timestamp>;
