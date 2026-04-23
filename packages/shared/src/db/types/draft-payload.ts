import { z } from "zod";

export const draftPayloadSchema = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string(),
});

export type DraftPayload = z.infer<typeof draftPayloadSchema>;
