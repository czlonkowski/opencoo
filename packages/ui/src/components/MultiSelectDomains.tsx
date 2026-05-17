/**
 * MultiSelectDomains — reusable domain multi-select picker
 * (PR-W4-UI, phase-a appendix #15).
 *
 * Renders a checkbox list of domains the operator can toggle.
 * Mirrors the output-channel multi-select pattern in
 * AgentInstanceDetail's "Output channels" section: same row
 * style, same loading / empty / error states, same disabled
 * gating during a parent's busy window.
 *
 * The component reads `/api/admin/domains` once on mount;
 * disabled rows are excluded from the toggleable surface (a
 * scope_domain_id pointing at a disabled domain would surface
 * 422 unknown_scope_domain_ids on the server — better to hide
 * it than to let the operator pick something the server will
 * reject).
 *
 * The selected-id list is controlled by the parent so the
 * component does not own dirty-tracking; parents wire that to
 * their own Save button.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { fetchAdmin, fetchOptsFor } from "../lib/api.js";
import type { Domain } from "../types.js";

export interface MultiSelectDomainsProps {
  readonly selectedIds: ReadonlyArray<string>;
  readonly onChange: (next: ReadonlyArray<string>) => void;
  readonly disabled?: boolean;
  /** @internal Test seam. */
  readonly fetchImpl?: typeof fetch;
}

interface DomainsResponse {
  readonly rows: ReadonlyArray<Domain>;
}

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 0",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-mono)",
};

const CONTAINER_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-m)",
  padding: "var(--space-2) var(--space-3)",
  maxHeight: 240,
  overflowY: "auto",
};

export function MultiSelectDomains(props: MultiSelectDomainsProps): JSX.Element {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<ReadonlyArray<Domain> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  useEffect((): void => {
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<DomainsResponse>(
          "/api/admin/domains",
          fetchOptsFor(props.fetchImpl),
        );
        if (!mountedRef.current) return;
        setCatalog(r.rows);
      } catch (err) {
        if (!mountedRef.current) return;
        // Surface the translated transient copy directly so the
        // operator sees actionable text — mirrors the
        // AgentInstanceDetail catalogError pattern.
        setError(err instanceof Error ? err.message : t("errors.transient"));
      }
    })();
  }, []);

  const toggle = (id: string): void => {
    if (props.disabled === true) return;
    const next = props.selectedIds.includes(id)
      ? props.selectedIds.filter((sid) => sid !== id)
      : [...props.selectedIds, id];
    props.onChange(next);
  };

  if (error !== null) {
    return (
      <div
        style={{
          color: "var(--alert)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-micro)",
        }}
      >
        {error}
      </div>
    );
  }
  if (catalog === null) {
    return (
      <div style={{ color: "var(--ink-3)" }}>{t("common.loading")}</div>
    );
  }

  // Disabled-domain rows would 422 on the server, so filter them
  // out at the UI surface. Operators who need to scope to a
  // disabled domain must re-enable it first (v0.1 has no
  // re-enable; create a fresh domain).
  const selectable = catalog.filter(
    (d) => d.disabledAt === null || d.disabledAt === undefined,
  );

  if (selectable.length === 0) {
    return (
      <div style={{ color: "var(--ink-3)" }}>
        {t("multiSelectDomains.empty")}
      </div>
    );
  }

  return (
    <div style={CONTAINER_STYLE} data-testid="multi-select-domains">
      {selectable.map((d) => {
        const checked = props.selectedIds.includes(d.id);
        return (
          <label key={d.id} style={ROW_STYLE}>
            <input
              type="checkbox"
              checked={checked}
              onChange={(): void => toggle(d.id)}
              disabled={props.disabled === true}
              data-domain-id={d.id}
            />
            <span style={{ color: "var(--ink-3)" }}>{d.slug}</span>
            <span>—</span>
            <span>{d.name}</span>
          </label>
        );
      })}
    </div>
  );
}
