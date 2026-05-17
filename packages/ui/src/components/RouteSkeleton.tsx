/**
 * RouteSkeleton — Suspense fallback composer per route (PR-B2,
 * wave-16, phase-a appendix #16).
 *
 * Each route renders one of three generic shapes during its
 * `React.lazy` import phase:
 *
 *   - **table**     — five `<Skeleton.Row>` placeholders inside
 *                     a `<table>`. Used for list-shaped routes
 *                     (Domains, Sources, Agents, Outputs, Audit,
 *                     Activity, Cost, Review).
 *   - **cards**     — three `<Skeleton.Block height={120}>`
 *                     stacked vertically with 16px gap.
 *                     Used for Reports (heartbeat-card stack).
 *   - **editor**    — two `<Skeleton.Field>` rows over a single
 *                     `<Skeleton.Block height={240}>`. Used for
 *                     Prompts + LlmPolicy (form-shaped routes).
 *
 * The composer carries the design-system invariants intact —
 * Skeleton primitives already enforce no shadow / no animation
 * loop / role=status. This wrapper adds layout + padding only.
 *
 * The `data-route-skeleton="<tab>"` attribute lets the route-
 * lazy unit test pin which fallback shape the Suspense
 * boundary rendered without depending on internal class names.
 */
import type { Tab } from "../types.js";

import { Skeleton } from "./Skeleton.js";

type Shape = "table" | "cards" | "editor";

/** Route → fallback shape. The map is the single source of
 *  truth — App.tsx uses the same key set for the Suspense
 *  boundary so adding a new Tab must extend this record OR
 *  the TypeScript compiler errors (Record<Tab, …>). */
const SHAPE_FOR_TAB: Record<Tab, Shape> = {
  domains: "table",
  sources: "table",
  agents: "table",
  outputs: "table",
  llmPolicy: "editor",
  prompts: "editor",
  activity: "table",
  review: "table",
  reports: "cards",
  audit: "table",
  cost: "table",
};

const PAD = "20px 24px";

function TableShape(): JSX.Element {
  return (
    <div style={{ padding: PAD }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <Skeleton.Row mono cols={5} />
          <Skeleton.Row mono cols={5} />
          <Skeleton.Row mono cols={5} />
          <Skeleton.Row mono cols={5} />
          <Skeleton.Row mono cols={5} />
        </tbody>
      </table>
    </div>
  );
}

function CardsShape(): JSX.Element {
  return (
    <div
      style={{
        padding: PAD,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <Skeleton.Block height={120} />
      <Skeleton.Block height={120} />
      <Skeleton.Block height={120} />
    </div>
  );
}

function EditorShape(): JSX.Element {
  return (
    <div
      style={{
        padding: PAD,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <Skeleton.Field />
      <Skeleton.Field />
      <Skeleton.Block height={240} />
    </div>
  );
}

interface RouteSkeletonProps {
  readonly route: Tab;
}

export function RouteSkeleton(props: RouteSkeletonProps): JSX.Element {
  const shape = SHAPE_FOR_TAB[props.route];
  return (
    <div data-route-skeleton={props.route}>
      {shape === "table" ? <TableShape /> : null}
      {shape === "cards" ? <CardsShape /> : null}
      {shape === "editor" ? <EditorShape /> : null}
    </div>
  );
}

/** Exposed for tests + parity sanity checks in App.tsx. */
export const ROUTE_SKELETON_SHAPES: Readonly<Record<Tab, Shape>> = SHAPE_FOR_TAB;
