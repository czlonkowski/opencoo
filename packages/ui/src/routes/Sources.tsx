/**
 * Sources tab — list of source-binding rows (PR 28 read-only) +
 * `+ New binding` create flow (phase-a appendix #2 — closes
 * the regression PR 29 introduced).
 *
 * Phase-a appendix #4 PR-A: enriched row with server-computed status,
 * human-readable name, lastEventAt relative time, and lastError.
 * The old client-side `b.enabled ? "ok" : "paused"` derivation is
 * removed — the server now owns the 3-state health signal.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "../components/Badge.js";
import { Btn } from "../components/Btn.js";
import { Card } from "../components/Card.js";
import { NewSourceBindingModal } from "../components/NewSourceBindingModal.js";
import { fetchAdmin } from "../lib/api.js";
import type { SourceBinding } from "../types.js";

interface SourcesResponse {
  readonly rows: ReadonlyArray<SourceBinding>;
}

/**
 * Format an ISO timestamp as a human-readable relative time string.
 * Examples: "2h ago", "3d ago", "just now".
 * Used for the lastEventAt column.
 */
function formatRelativeTime(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  if (diffMs < 0) return "just now";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

export interface SourcesProps {
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

export function Sources(props: SourcesProps = {}): JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ReadonlyArray<SourceBinding> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const fetchOpts =
    props.fetchImpl !== undefined
      ? { fetchImpl: props.fetchImpl as typeof fetch }
      : {};

  useEffect((): void => {
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<SourcesResponse>(
          "/api/admin/source-bindings",
          fetchOpts,
        );
        setRows(r.rows);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    // refetch when the create modal flips refreshNonce.
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
          <h1 style={{ margin: 0 }}>{t("sources.title")}</h1>
          <p style={{ margin: "4px 0 0", color: "var(--ink-3)" }}>{t("sources.subtitle")}</p>
        </div>
        <Btn variant="primary" onClick={(): void => setCreateOpen(true)}>
          {t("sources.newBinding")}
        </Btn>
      </div>
      <Card>
        {error !== null ? (
          <div style={{ color: "var(--alert)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)" }}>
            {error}
          </div>
        ) : rows === null ? (
          <div style={{ color: "var(--ink-3)" }}>{t("common.loading")}</div>
        ) : rows.length === 0 ? (
          <div style={{ color: "var(--ink-3)" }}>{t("sources.empty")}</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1.2fr 1fr 1fr 1.2fr auto", gap: 12 }}>
            <div className="t-micro">{t("sources.columns.name")}</div>
            <div className="t-micro">{t("sources.columns.type")}</div>
            <div className="t-micro">{t("sources.columns.domain")}</div>
            <div className="t-micro">{t("sources.columns.reviewMode")}</div>
            <div className="t-micro">{t("sources.columns.lastEvent")}</div>
            <div className="t-micro">{t("sources.columns.lastError")}</div>
            <div className="t-micro">{t("sources.columns.status")}</div>
            {rows.map((b) => {
              // Status comes from the server (phase-a appendix #4 PR-A).
              // The old client-side derivation `b.enabled ? "ok" : "paused"`
              // is removed — the server now computes the 3-state signal.
              const tone =
                b.status === "alert"
                  ? "alert"
                  : b.status === "advisory"
                    ? "advisory"
                    : b.status === "healthy"
                      ? "ok"
                      : "neutral";
              return (
                <div key={b.id} style={{ display: "contents" }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-mono)" }}>{b.name}</div>
                  <div style={{ color: "var(--ink-3)" }}>{b.adapterSlug}</div>
                  <div>{b.domainSlug}</div>
                  <div style={{ color: "var(--ink-2)" }}>{b.reviewMode}</div>
                  <div style={{ color: "var(--ink-3)", fontSize: "var(--fs-micro)", fontFamily: "var(--font-mono)" }}>
                    {b.lastEventAt !== null ? formatRelativeTime(b.lastEventAt) : "—"}
                  </div>
                  <div style={{ color: "var(--ink-3)", fontSize: "var(--fs-micro)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {b.lastError ?? ""}
                  </div>
                  {b.status !== null
                    ? <Badge tone={tone}>{t(`sources.status.${b.status}`)}</Badge>
                    : <span />}
                </div>
              );
            })}
          </div>
        )}
      </Card>
      {createOpen ? (
        <NewSourceBindingModal
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
    </div>
  );
}
