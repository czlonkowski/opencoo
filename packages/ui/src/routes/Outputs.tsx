/**
 * Outputs tab — list of `output_channels` rows (PR-Z4, phase-a
 * appendix #12 G5).
 *
 * Mirrors `Sources.tsx`'s shape: list + `+ New output channel`
 * modal + per-row drill-down. The list pulls from
 * `/api/admin/output-channels`; the modal pulls the adapter
 * descriptor map from `/api/admin/adapters` (the same endpoint
 * the source-bindings modal uses, extended with `outputAdapters[]`).
 *
 * Hard-nos honored: no gradients, no emoji, lowercase opencoo,
 * `--alert` reserved for destructive surfaces, design-system
 * tokens only.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "../components/Btn.js";
import { Card } from "../components/Card.js";
import { NewOutputChannelModal } from "../components/NewOutputChannelModal.js";
import { OutputChannelDetail } from "../components/OutputChannelDetail.js";
import { fetchAdmin, fetchOptsFor } from "../lib/api.js";
import type { OutputChannel } from "../types.js";

interface OutputsResponse {
  readonly rows: readonly OutputChannel[];
}

export interface OutputsProps {
  /** @internal Test seam. */
  readonly fetchImpl?: typeof fetch;
}

export function Outputs(props: OutputsProps = {}): JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<readonly OutputChannel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<OutputChannel | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const opts = fetchOptsFor(props.fetchImpl);

  useEffect((): void => {
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<OutputsResponse>(
          "/api/admin/output-channels",
          opts,
        );
        setRows(r.rows);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [refreshNonce]);

  return (
    <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>{t("outputs.title")}</h1>
          <p style={{ margin: "4px 0 0", color: "var(--ink-3)" }}>{t("outputs.subtitle")}</p>
        </div>
        <Btn variant="primary" onClick={(): void => setCreateOpen(true)}>
          {t("outputs.newChannel")}
        </Btn>
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
          <div style={{ color: "var(--ink-3)" }}>{t("outputs.empty")}</div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.4fr 1fr 1fr 1.2fr",
              gap: 12,
            }}
          >
            <div className="t-micro">{t("outputs.columns.name")}</div>
            <div className="t-micro">{t("outputs.columns.adapter")}</div>
            <div className="t-micro">{t("outputs.columns.enabled")}</div>
            <div className="t-micro">{t("outputs.columns.createdAt")}</div>
            {rows.map((c) => {
              // Mirrors `Sources.tsx`'s grid-row click target: every
              // cell shares the same `onClick` + `onKeyDown` + `aria-label`
              // so the operator can drill in from any column AND so
              // keyboard / screen-reader users get parity with mouse
              // users. The grid uses `display: contents` so we can't
              // wrap cells in a single clickable element without
              // breaking the layout — per-cell handlers are the
              // simplest path that preserves the 4-column grid.
              const onRowClick = (): void => setSelected(c);
              const onRowKey = (e: React.KeyboardEvent): void => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelected(c);
                }
              };
              const cellStyle: React.CSSProperties = {
                cursor: "pointer",
                padding: "4px 0",
              };
              const cellProps = {
                role: "button",
                tabIndex: 0,
                onClick: onRowClick,
                onKeyDown: onRowKey,
                "aria-label": t("outputs.detail.openAriaLabel", { name: c.name }),
              } as const;
              return (
                <div
                  key={c.id}
                  style={{ display: "contents" }}
                  data-channel-id={c.id}
                >
                  <div
                    style={{
                      ...cellStyle,
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--fs-mono)",
                    }}
                    {...cellProps}
                  >
                    {c.name}
                  </div>
                  <div
                    style={{ ...cellStyle, color: "var(--ink-3)" }}
                    {...cellProps}
                  >
                    {c.adapterSlug}
                  </div>
                  <div
                    style={{
                      ...cellStyle,
                      color: c.enabled ? "var(--healthy)" : "var(--ink-3)",
                    }}
                    {...cellProps}
                  >
                    {c.enabled ? t("outputs.enabledYes") : t("outputs.enabledNo")}
                  </div>
                  <div
                    style={{
                      ...cellStyle,
                      color: "var(--ink-3)",
                      fontSize: "var(--fs-micro)",
                      fontFamily: "var(--font-mono)",
                    }}
                    {...cellProps}
                  >
                    {c.createdAt ?? "—"}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      {createOpen ? (
        <NewOutputChannelModal
          {...(props.fetchImpl !== undefined
            ? { fetchImpl: props.fetchImpl as typeof fetch }
            : {})}
          onCreated={(): void => {
            setCreateOpen(false);
            setRefreshNonce((n) => n + 1);
          }}
          onClose={(): void => setCreateOpen(false)}
        />
      ) : null}
      {selected !== null ? (
        <OutputChannelDetail
          channel={selected}
          {...(props.fetchImpl !== undefined
            ? { fetchImpl: props.fetchImpl as typeof fetch }
            : {})}
          onClose={(): void => setSelected(null)}
          onChanged={(): void => {
            setSelected(null);
            setRefreshNonce((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}
