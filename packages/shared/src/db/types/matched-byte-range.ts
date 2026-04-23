import { z } from "zod";

export const matchedByteRangeSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

export const matchedByteRangeArraySchema = z.array(matchedByteRangeSchema);

export type MatchedByteRange = z.infer<typeof matchedByteRangeSchema>;
