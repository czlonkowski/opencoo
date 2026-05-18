/**
 * `renderRoute` — mount one of the eleven top-level routes inside
 * the same App-shell landmarks the production tree emits, so a
 * cross-route snapshot test can assert against the real
 * `<main aria-labelledby="opencoo-page-h1">` / `<nav>` / `<header>`
 * markup (not a fixture stand-in).
 *
 * PR-C7 (wave-16, phase-a appendix #16) ships this. The shell is
 * a strict mirror of `App.tsx`'s post-auth render — Sidebar
 * (Chrome.tsx) on the left, TopBar header above, `<main>` below,
 * with the same `aria-labelledby="opencoo-page-h1"` wiring that
 * resolves against the route's hidden `<h1>`. The PatEntryModal
 * + lazy-load Suspense + Cmd-K palette are NOT mounted — they
 * are auth/lifecycle concerns orthogonal to the cross-route
 * visual contract.
 *
 * The eleven routes each accept a `fetchImpl` test-seam prop (the
 * `LlmPolicy` route reads `globalThis.fetch`); the helper accepts
 * one via opts.fetchImpl and forwards it to every supporting route.
 * Routes are imported eagerly here — the lazy-route adapter from
 * App.tsx is App's concern, not this helper's. The helper is also
 * the single place that wraps in `<ToastProvider>` (B7) so any
 * route that calls `useToast()` (Outputs.tsx and onwards) mounts
 * without throwing.
 */
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";

import { Sidebar, TopBar } from "../../src/components/Chrome.js";
import { ToastProvider } from "../../src/components/Toast.js";
import { Activity } from "../../src/routes/Activity.js";
import { Agents } from "../../src/routes/Agents.js";
import { Audit } from "../../src/routes/Audit.js";
import { Cost } from "../../src/routes/Cost.js";
import { Domains } from "../../src/routes/Domains.js";
import { LlmPolicy } from "../../src/routes/LlmPolicy.js";
import { Outputs } from "../../src/routes/Outputs.js";
import { Prompts } from "../../src/routes/Prompts.js";
import { Reports } from "../../src/routes/Reports.js";
import { Review } from "../../src/routes/Review.js";
import { Sources } from "../../src/routes/Sources.js";
import type { Tab } from "../../src/types.js";

export interface RenderRouteOpts {
  /** Test-seam fetch impl forwarded to every route that accepts
   *  one. The `LlmPolicy` route doesn't expose a seam — it reads
   *  `globalThis.fetch`, so callers should stub the global on
   *  setup if they intend to mount that route. */
  readonly fetchImpl?: typeof fetch;
}

/** Returns the route element for a given Tab, threading the
 *  optional fetch stub through. Exported so callers can render
 *  just the route body without the shell (used by the no-inline-
 *  hex-color sweep, which doesn't care about chrome). */
export function makeRouteElement(
  tab: Tab,
  opts: RenderRouteOpts = {},
): ReactElement {
  const fetchProp =
    opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {};
  switch (tab) {
    case "domains":
      return <Domains {...fetchProp} />;
    case "sources":
      return <Sources {...fetchProp} />;
    case "agents":
      return <Agents {...fetchProp} />;
    case "outputs":
      return <Outputs {...fetchProp} />;
    case "llmPolicy":
      // No fetchImpl prop on LlmPolicy — it reads `globalThis.fetch`.
      return <LlmPolicy />;
    case "prompts":
      return <Prompts {...fetchProp} />;
    case "activity":
      return <Activity {...fetchProp} />;
    case "review":
      return <Review {...fetchProp} />;
    case "reports":
      return <Reports {...fetchProp} />;
    case "audit":
      return <Audit {...fetchProp} />;
    case "cost":
      return <Cost {...fetchProp} />;
  }
}

/** Mount the given Tab inside the post-auth App shell. Asserts
 *  the same landmark structure App.tsx renders:
 *
 *    <nav aria-label="primary navigation">  ← Sidebar
 *    <header role="banner">                  ← TopBar
 *    <main aria-labelledby="opencoo-page-h1"> ← route body
 *
 *  The wrapping <ToastProvider> survives the auth boundary in
 *  production (top-of-tree mount); we mirror that here. */
export function renderRoute(
  tab: Tab,
  opts: RenderRouteOpts = {},
): RenderResult {
  // Use a no-op setTab so any route-driven sidebar interactions
  // don't try to re-navigate during the test. The visual-contract
  // assertions only read DOM shape; they don't dispatch nav.
  const noop = (): void => undefined;
  return render(
    <ToastProvider>
      <div data-testid="opencoo-app-shell">
        <Sidebar tab={tab} setTab={noop} />
        <div>
          <TopBar tab={tab} username="ops" onLogout={noop} />
          <main aria-labelledby="opencoo-page-h1">
            {makeRouteElement(tab, opts)}
          </main>
        </div>
      </div>
    </ToastProvider>,
  );
}

/** Canonical list of every Tab the visual-consistency suite walks.
 *  Mirrors the `Tab` union in `src/types.ts` and the
 *  `ROUTE_PREFETCH` map in `App.tsx` — both are sources of truth;
 *  any new entry there must show up here too (the suite asserts
 *  `ALL_TABS.length === 11` to surface the omission). */
export const ALL_TABS: readonly Tab[] = [
  "domains",
  "sources",
  "agents",
  "outputs",
  "prompts",
  "reports",
  "activity",
  "audit",
  "review",
  "cost",
  "llmPolicy",
] as const;
