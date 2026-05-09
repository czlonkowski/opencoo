/**
 * Domains tab — listing + `+ New domain` create flow + per-row
 * drill-down (PR-R1, phase-a appendix #10).
 *
 * Phase-a appendix #2 closed the read-only-listing regression by
 * adding the create button + modal; PR-R1 layers on the row drill-
 * down (DomainDetail) for edit / soft-disable / hard-delete, the
 * "Show disabled" toggle (?include_disabled=1), and the disabled
 * badge on retired rows.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "../components/Btn.js";
import { Card } from "../components/Card.js";
import { DomainDetail } from "../components/DomainDetail.js";
import { NewDomainModal } from "../components/NewDomainModal.js";
import { fetchAdmin, fetchOptsFor } from "../lib/api.js";
import type { Domain } from "../types.js";

interface DomainsResponse {
  readonly rows: ReadonlyArray<Domain>;
}

export interface DomainsProps {
  /** @internal Test seam — defaults to globalThis.fetch.
   *  Threaded through fetchAdmin so the page's calls are
   *  driven by the same mock the modal uses. */
  readonly fetchImpl?: typeof fetch;
}

const ROW_BUTTON_STYLE: CSSProperties = {
  display: "contents",
  cursor: "pointer",
};

const TOGGLE_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--fs-small)",
  color: "var(--ink-3)",
};

export function Domains(props: DomainsProps = {}): JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ReadonlyArray<Domain> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [showDisabled, setShowDisabled] = useState(false);
  const [selected, setSelected] = useState<Domain | null>(null);

  const fetchOpts = fetchOptsFor(props.fetchImpl);

  useEffect((): void => {
    void (async (): Promise<void> => {
      try {
        const path = showDisabled
          ? "/api/admin/domains?include_disabled=1"
          : "/api/admin/domains";
        const r = await fetchAdmin<DomainsResponse>(path, fetchOpts);
        setRows(r.rows);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    // refetch when the create modal flips refreshNonce, when the
    // detail modal commits a change, or when the disabled-toggle
    // flips.
  }, [refreshNonce, showDisabled]);

  return (
    <div
      style={{
        padding: "24px 28px",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>{t("domains.title")}</h1>
          <p style={{ margin: "4px 0 0", color: "var(--ink-3)" }}>
            {t("domains.subtitle")}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <label style={TOGGLE_ROW_STYLE}>
            <input
              type="checkbox"
              checked={showDisabled}
              onChange={(e): void => setShowDisabled(e.target.checked)}
            />
            {t("domains.showDisabled")}
          </label>
          <Btn variant="primary" onClick={(): void => setCreateOpen(true)}>
            {t("domains.newDomain")}
          </Btn>
        </div>
      </div>
      <Card>
        {error !== null ? (
          <div
            style={{
              color: "var(--alert)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-micro)",
            }}
          >
            {error}
          </div>
        ) : rows === null ? (
          <div style={{ color: "var(--ink-3)" }}>{t("common.loading")}</div>
        ) : rows.length === 0 ? (
          <div style={{ color: "var(--ink-3)" }}>{t("domains.empty")}</div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr 0.6fr 0.6fr",
              gap: 12,
            }}
          >
            <div className="t-micro">{t("domains.columns.slug")}</div>
            <div className="t-micro">{t("domains.columns.name")}</div>
            <div className="t-micro">{t("domains.columns.class")}</div>
            <div className="t-micro">{t("domains.columns.locale")}</div>
            <div className="t-micro">{t("domains.columns.aggregator")}</div>
            {rows.map((d) => {
              const disabled =
                d.disabledAt !== null && d.disabledAt !== undefined;
              return (
                // Treat row contents as a clickable affordance that
                // opens the detail modal. `display: contents` keeps
                // the row laid out by the parent grid; the wrapping
                // `button` provides keyboard access (Enter/Space)
                // without breaking the layout. Disabled badge is
                // informational — `--ink-3` (muted), NOT `--alert`.
                <button
                  key={d.id}
                  type="button"
                  style={{
                    ...ROW_BUTTON_STYLE,
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    textAlign: "left",
                    color: "inherit",
                    font: "inherit",
                  }}
                  onClick={(): void => setSelected(d)}
                  aria-label={`${d.slug} — open detail`}
                >
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--fs-mono)",
                      display: "flex",
                      gap: "var(--space-2)",
                      alignItems: "baseline",
                    }}
                  >
                    {d.slug}
                    {disabled ? (
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "var(--fs-micro)",
                          color: "var(--ink-3)",
                          letterSpacing: "0.08em",
                          textTransform: "uppercase",
                        }}
                      >
                        · {t("domains.disabledBadge")}
                      </span>
                    ) : null}
                  </div>
                  <div>{d.name}</div>
                  <div style={{ color: "var(--ink-3)" }}>{d.class}</div>
                  <div style={{ color: "var(--ink-3)" }}>{d.locale}</div>
                  <div
                    style={{
                      color: d.isAggregator
                        ? "var(--healthy)"
                        : "var(--ink-3)",
                    }}
                  >
                    {d.isAggregator ? t("common.yes") : t("common.no")}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Card>
      {createOpen ? (
        <NewDomainModal
          {...fetchOpts}
          onCreated={(): void => {
            setCreateOpen(false);
            setRefreshNonce((n) => n + 1);
          }}
          onClose={(): void => setCreateOpen(false)}
        />
      ) : null}
      {selected !== null ? (
        <DomainDetail
          domain={selected}
          {...fetchOpts}
          onClose={(): void => setSelected(null)}
          onChanged={(): void => setRefreshNonce((n) => n + 1)}
        />
      ) : null}
    </div>
  );
}
