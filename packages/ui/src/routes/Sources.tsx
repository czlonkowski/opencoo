/**
 * Sources tab — list of source-binding rows (PR 28 read-only) +
 * `+ New binding` create flow (phase-a appendix #2 — closes
 * the regression PR 29 introduced).
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1.2fr 1fr auto", gap: 12 }}>
            <div className="t-micro">{t("sources.columns.binding")}</div>
            <div className="t-micro">{t("sources.columns.type")}</div>
            <div className="t-micro">{t("sources.columns.domain")}</div>
            <div className="t-micro">{t("sources.columns.reviewMode")}</div>
            <div className="t-micro">{t("sources.columns.status")}</div>
            {rows.map((b) => {
              const status = b.enabled ? "ok" : "paused";
              const tone = status === "ok" ? "ok" : "neutral";
              return (
                <div key={b.id} style={{ display: "contents" }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-mono)" }}>{b.id}</div>
                  <div style={{ color: "var(--ink-3)" }}>{b.adapterSlug}</div>
                  <div>{b.domainSlug}</div>
                  <div style={{ color: "var(--ink-2)" }}>{b.reviewMode}</div>
                  <Badge tone={tone}>{t(`sources.status.${status}`)}</Badge>
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
