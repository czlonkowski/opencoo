/**
 * LLM policy tab — preview + apply with sovereignty-diff
 * confirmation. Uses PR 28's `verifySovereigntyDiffToken`
 * primitives via the new `/preview` and `/apply` endpoints
 * (decision Q4 — paired with this UI).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "../components/Btn.js";
import { Card } from "../components/Card.js";
import { DiffPreviewDialog } from "../components/DiffPreviewDialog.js";
import { fetchAdmin } from "../lib/api.js";
import type { Domain, SovereigntyDiffPreview } from "../types.js";

interface DomainsResponse {
  readonly rows: ReadonlyArray<Domain & { llmPolicy?: Record<string, unknown> }>;
}

export function LlmPolicy(): JSX.Element {
  const { t } = useTranslation();
  const [domains, setDomains] = useState<DomainsResponse["rows"] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [proposed, setProposed] = useState<string>("");
  const [preview, setPreview] = useState<SovereigntyDiffPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [appliedNotice, setAppliedNotice] = useState<string | null>(null);

  useEffect((): void => {
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<DomainsResponse>("/api/admin/domains");
        setDomains(r.rows);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const selected = domains?.find((d) => d.id === selectedId) ?? null;

  const onSelect = (d: DomainsResponse["rows"][number]): void => {
    setSelectedId(d.id);
    setProposed(JSON.stringify(d.llmPolicy ?? {}, null, 2));
    setPreview(null);
    setAppliedNotice(null);
    setApplyError(null);
  };

  const previewClick = async (): Promise<void> => {
    if (selectedId === null) return;
    setApplyError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(proposed);
    } catch {
      setApplyError("Invalid JSON.");
      return;
    }
    try {
      const r = await fetchAdmin<SovereigntyDiffPreview>(
        `/api/admin/domains/${selectedId}/llm-policy/preview`,
        { method: "POST", body: { proposed: parsed } },
      );
      setPreview(r);
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
    }
  };

  const applyClick = async (): Promise<void> => {
    if (selectedId === null || preview === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(proposed);
    } catch {
      setApplyError("Invalid JSON.");
      return;
    }
    try {
      await fetchAdmin(`/api/admin/domains/${selectedId}/llm-policy/apply`, {
        method: "POST",
        body: { proposed: parsed, token: preview.token },
      });
      setPreview(null);
      setAppliedNotice(t("llmPolicy.applied"));
      // Re-fetch the current policy.
      const r = await fetchAdmin<DomainsResponse>("/api/admin/domains");
      setDomains(r.rows);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Distinguish payload_mismatch / expired into structured
      // operator-friendly messages.
      if (msg.includes("payload_mismatch")) {
        setApplyError(t("llmPolicy.tokenMismatch"));
      } else if (msg.includes("expired")) {
        setApplyError(t("llmPolicy.diffExpired"));
      } else {
        setApplyError(msg);
      }
    }
  };

  return (
    <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ margin: 0 }}>{t("llmPolicy.title")}</h1>
        <p style={{ margin: "4px 0 0", color: "var(--ink-3)" }}>{t("llmPolicy.subtitle")}</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 16 }}>
        <Card>
          {error !== null ? (
            <div style={{ color: "var(--alert)" }}>{error}</div>
          ) : domains === null ? (
            <div style={{ color: "var(--ink-3)" }}>{t("common.loading")}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {domains.map((d) => (
                <button
                  key={d.id}
                  onClick={(): void => onSelect(d)}
                  style={{
                    textAlign: "left",
                    font: "inherit",
                    padding: "6px 8px",
                    background: selectedId === d.id ? "var(--paper-2)" : "transparent",
                    border: "1px solid",
                    borderColor: selectedId === d.id ? "var(--rule)" : "transparent",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--fs-mono)",
                  }}
                >
                  {d.slug}
                </button>
              ))}
            </div>
          )}
        </Card>
        <Card>
          {selected === null ? (
            <div style={{ color: "var(--ink-3)" }}>{t("llmPolicy.empty")}</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <textarea
                value={proposed}
                onChange={(e): void => setProposed(e.target.value)}
                rows={14}
                aria-label={`llm-policy-${selected.slug}`}
                style={{
                  width: "100%",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--fs-mono)",
                  padding: "10px 12px",
                  background: "var(--paper)",
                  border: "1px solid var(--rule)",
                  borderRadius: "var(--radius-m)",
                  color: "var(--ink)",
                }}
              />
              {appliedNotice !== null ? (
                <div style={{ color: "var(--healthy)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)" }}>
                  {appliedNotice}
                </div>
              ) : null}
              {applyError !== null ? (
                <div data-testid="apply-error" style={{ color: "var(--alert)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-micro)" }}>
                  {applyError}
                </div>
              ) : null}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Btn variant="primary" onClick={(): void => void previewClick()}>
                  {t("llmPolicy.preview")}
                </Btn>
              </div>
            </div>
          )}
        </Card>
      </div>
      {preview !== null ? (
        <DiffPreviewDialog
          preview={preview}
          onApply={applyClick}
          onCancel={(): void => setPreview(null)}
          errorMessage={applyError}
        />
      ) : null}
    </div>
  );
}
