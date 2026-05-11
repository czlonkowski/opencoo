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
              const onRowClick = (): void => setSelected(c);
              const cellStyle: React.CSSProperties = {
                cursor: "pointer",
                padding: "4px 0",
              };
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
                    onClick={onRowClick}
                    role="button"
                    tabIndex={0}
                  >
                    {c.name}
                  </div>
                  <div
                    style={{ ...cellStyle, color: "var(--ink-3)" }}
                    onClick={onRowClick}
                    role="button"
                    tabIndex={0}
                  >
                    {c.adapterSlug}
                  </div>
                  <div
                    style={{
                      ...cellStyle,
                      color: c.enabled ? "var(--healthy)" : "var(--ink-3)",
                    }}
                    onClick={onRowClick}
                    role="button"
                    tabIndex={0}
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
                    onClick={onRowClick}
                    role="button"
                    tabIndex={0}
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
