/**
 * Domains tab — read-only listing of every domain row.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Card } from "../components/Card.js";
import { fetchAdmin } from "../lib/api.js";
import type { Domain } from "../types.js";

interface DomainsResponse {
  readonly rows: ReadonlyArray<Domain>;
}

export function Domains(): JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ReadonlyArray<Domain> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect((): void => {
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<DomainsResponse>("/api/admin/domains");
        setRows(r.rows);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  return (
    <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ margin: 0 }}>{t("domains.title")}</h1>
        <p style={{ margin: "4px 0 0", color: "var(--ink-3)" }}>
          {t("domains.subtitle")}
        </p>
      </div>
      <Card>
        {error !== null ? (
          <div style={{ color: "var(--alert)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)" }}>
            {error}
          </div>
        ) : rows === null ? (
          <div style={{ color: "var(--ink-3)" }}>{t("common.loading")}</div>
        ) : rows.length === 0 ? (
          <div style={{ color: "var(--ink-3)" }}>{t("domains.empty")}</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 0.6fr 0.6fr", gap: 12 }}>
            <div className="t-micro">{t("domains.columns.slug")}</div>
            <div className="t-micro">{t("domains.columns.name")}</div>
            <div className="t-micro">{t("domains.columns.class")}</div>
            <div className="t-micro">{t("domains.columns.locale")}</div>
            <div className="t-micro">{t("domains.columns.aggregator")}</div>
            {rows.map((d) => (
              <div key={d.id} style={{ display: "contents" }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-mono)" }}>{d.slug}</div>
                <div>{d.name}</div>
                <div style={{ color: "var(--ink-3)" }}>{d.class}</div>
                <div style={{ color: "var(--ink-3)" }}>{d.locale}</div>
                <div style={{ color: d.isAggregator ? "var(--healthy)" : "var(--ink-3)" }}>
                  {d.isAggregator ? "yes" : "no"}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
