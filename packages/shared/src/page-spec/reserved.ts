/**
 * OKF v0.1 reserved filenames (SPEC §3.1).
 *
 * `index.md` and `log.md` have defined meaning at ANY level of the
 * bundle hierarchy and MUST NOT be used for concept documents. The
 * conformance validator (`./validate.ts`) treats them specially:
 * they are exempt from the `type` requirement and instead follow the
 * §6 (index) / §7 (log) structural rules.
 */

export const RESERVED_FILENAMES = ["index.md", "log.md"] as const;

export type ReservedFilename = (typeof RESERVED_FILENAMES)[number];

/** Last path segment, ignoring a leading `/` (OKF bundle-relative form). */
function basename(pagePath: string): string {
  const noLead = pagePath.startsWith("/") ? pagePath.slice(1) : pagePath;
  const parts = noLead.split("/");
  return parts[parts.length - 1] ?? noLead;
}

/** True when the path's basename is a reserved filename at any level. */
export function isReserved(pagePath: string): boolean {
  return (RESERVED_FILENAMES as readonly string[]).includes(basename(pagePath));
}

/**
 * True only for the bundle-root `index.md` — the single place OKF v0.1
 * permits frontmatter inside an index file (the optional `okf_version`
 * declaration, SPEC §11).
 */
export function isBundleRootIndex(pagePath: string): boolean {
  const noLead = pagePath.startsWith("/") ? pagePath.slice(1) : pagePath;
  return noLead === "index.md";
}
