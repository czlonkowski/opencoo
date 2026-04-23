import { z } from "zod";

import type { DomainSlug } from "../db/brands.js";

// Tags enforced on every wiki commit per CONVENTIONS §4.2. Downstream
// audit tooling (git log greps, `opencoo source forget` machinery)
// keys on the prefix — adding a tag without updating those consumers
// will create tag-shaped commits they ignore.
export const WikiWriteTagSchema = z.enum([
  "[compiler]",
  "[lint]",
  "[builder]",
  "[review-applied]",
  "[schema-edit]",
  "[catalog-rename]",
  "[catalog-unarchive]",
  "[skill-supersede]",
]);
export type WikiWriteTag = z.infer<typeof WikiWriteTagSchema>;

// Three operation modes; discriminated by `mode`. `delete` needs no
// content; `replace`/`append` do. Runtime path-guard runs separately
// from Zod because the check is belt-and-suspenders — even if the
// caller pre-validates, wikiWrite re-validates.
export const WikiOperationSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("replace"),
    path: z.string().min(1),
    content: z.string(),
  }),
  z.object({
    mode: z.literal("append"),
    path: z.string().min(1),
    content: z.string(),
  }),
  z.object({
    mode: z.literal("delete"),
    path: z.string().min(1),
  }),
]);
export type WikiOperation = z.infer<typeof WikiOperationSchema>;

// Who asked for the write. `engine` (machine) is capped per-domain
// on deletes; `admin` (human with override authority) bypasses the
// cap but MUST carry the acting user id for audit.
export const WikiWriteCallerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("engine") }),
  z.object({ kind: z.literal("admin"), userId: z.string().min(1) }),
]);
export type WikiWriteCaller = z.infer<typeof WikiWriteCallerSchema>;

export const WikiAuthorSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});
export type WikiAuthor = z.infer<typeof WikiAuthorSchema>;

// Full entrypoint input. Two refinements beyond the field Zod:
//   1. `operations.length >= 1` — empty batch is a caller bug.
//   2. No duplicate `path` across operations — ambiguity is a caller
//      bug; fail loud rather than adopt silent last-write-wins.
export const WikiWriteInputSchema = z
  .object({
    domainSlug: z.string().min(1).max(64),
    tag: WikiWriteTagSchema,
    description: z.string().min(1).max(200),
    body: z.string().optional(),
    author: WikiAuthorSchema,
    coAuthors: z.array(WikiAuthorSchema).optional(),
    caller: WikiWriteCallerSchema,
    operations: z.array(WikiOperationSchema).min(1),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const op of value.operations) {
      if (seen.has(op.path)) {
        ctx.addIssue({
          code: "custom",
          path: ["operations"],
          message: `duplicate path in operations: ${op.path}`,
        });
        return;
      }
      seen.add(op.path);
    }
  });
export type WikiWriteInput = z.infer<typeof WikiWriteInputSchema>;

// Adapter surface. `writeAtomic` NEVER throws for staleness — stale
// is a normal return with `status: 'stale'` + the current HEAD so the
// caller can reload and retry. Transport/other failures go through
// exceptions (caller translates to WikiTransportError).
export type WriteAtomicResult =
  | { status: "ok"; sha: string }
  | { status: "stale"; currentSha: string };

export interface WriteAtomicArgs {
  readonly domainSlug: DomainSlug;
  readonly operations: ReadonlyArray<WikiOperation>;
  readonly commitMessage: string;
  readonly author: WikiAuthor;
  readonly coAuthors?: ReadonlyArray<WikiAuthor>;
  readonly parentSha: string;
}

export interface WikiAdapter {
  getHeadSha(domainSlug: DomainSlug): Promise<string>;
  readPage(
    domainSlug: DomainSlug,
    path: string,
  ): Promise<{ sha: string; content: string } | null>;
  writeAtomic(args: WriteAtomicArgs): Promise<WriteAtomicResult>;
}
