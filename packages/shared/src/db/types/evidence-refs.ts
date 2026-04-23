import { z } from "zod";

export const evidenceRefSchema = z.object({
  source_binding_id: z.string().uuid(),
  source_ref: z.string(),
  content_excerpt: z.string().optional(),
});

export const evidenceRefArraySchema = z.array(evidenceRefSchema);

export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
