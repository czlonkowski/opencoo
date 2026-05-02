/**
 * Review Dashboard — Surfacer candidates sub-view.
 *
 * Consumes `GET /api/admin/automation-candidates` (existing endpoint).
 * Approve/reject fires `POST /api/admin/automation-candidates/:id/decision`
 * (existing PR #28 state-machine endpoint).
 *
 * State machine: proposed → approved | rejected.
 * A 409 response means an illegal transition (row already decided);
 * the component shows an inline conflict notice.
 *
 * Security: all state-changing calls use existing audited endpoints
 * with CSRF tokens injected by fetchAdmin. No new endpoints.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "../../components/Btn.js";
import { fetchAdmin, ApiValidationError } from "../../lib/api.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AutomationCandidate {
  readonly id: string;
  readonly surfacerRunId: string;
  readonly sourcePageRefs: unknown;
  readonly proposal: unknown;
  readonly status: string;
  readonly rationale: string | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly createdAt: string;
}

interface AutomationCandidatesResponse {
  readonly rows: readonly AutomationCandidate[];
}

type RowDecision = "approved" | "rejected" | "conflict" | "error";

// ─── Props ───────────────────────────────────────────────────────────────────

export interface SurfacerCandidatesProps {
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildFetchOpts(
  fetchImpl: typeof fetch | undefined,
): { fetchImpl?: typeof fetch } {
  return fetchImpl !== undefined ? { fetchImpl } : {};
}

function NoticeRow(props: {
  readonly tone: "alert" | "muted";
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      style={{
        color: props.tone === "alert" ? "var(--alert)" : "var(--ink-3)",
        fontFamily: "var(--font-sans)",
        fontSize: 13,
        padding: "16px 0",
      }}
    >
      {props.children}
    </div>
  );
}

function extractProposalTitle(proposal: unknown): string {
  if (
    typeof proposal === "object" &&
    proposal !== null &&
    "title" in proposal &&
    typeof (proposal as { title?: unknown }).title === "string"
  ) {
    return (proposal as { title: string }).title;
  }
  return "—";
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SurfacerCandidates(
  props: SurfacerCandidatesProps = {},
): JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<readonly AutomationCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-row decision result: id → decision state
  const [decisions, setDecisions] = useState<Record<string, RowDecision>>({});

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetchAdmin<AutomationCandidatesResponse>(
          "/api/admin/automation-candidates",
          buildFetchOpts(props.fetchImpl),
        );
        setRows(r.rows);
      } catch {
        setError(t("common.error"));
      }
    })();
  }, []);

  if (error !== null) return <NoticeRow tone="alert">{error}</NoticeRow>;
  if (rows === null) return <NoticeRow tone="muted">{t("common.loading")}</NoticeRow>;
  if (rows.length === 0) {
    return <NoticeRow tone="muted">{t("review.candidates.empty")}</NoticeRow>;
  }

  const handleDecision = async (
    id: string,
    decision: "approve" | "reject",
    rationale?: string,
  ): Promise<void> => {
    try {
      await fetchAdmin(
        `/api/admin/automation-candidates/${id}/decision`,
        {
          method: "POST",
          body: { decision, ...(rationale !== undefined ? { rationale } : {}) },
          ...buildFetchOpts(props.fetchImpl),
        },
      );
      const resolved: RowDecision = decision === "approve" ? "approved" : "rejected";
      setDecisions((prev) => ({ ...prev, [id]: resolved }));
    } catch (err) {
      if (
        err instanceof ApiValidationError &&
        err.status === 409
      ) {
        // Illegal transition — the row was already decided by another session.
        setDecisions((prev) => ({ ...prev, [id]: "conflict" }));
      } else {
        setDecisions((prev) => ({ ...prev, [id]: "error" }));
      }
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontFamily: "var(--font-sans)",
          fontSize: 13,
        }}
      >
        <thead>
          <tr style={{ borderBottom: "1px solid var(--rule)" }}>
            {[
              t("review.candidates.columns.proposal"),
              t("review.candidates.columns.sourcePages"),
              t("review.candidates.columns.created"),
              t("review.candidates.columns.actions"),
            ].map((col) => (
              <th
                key={col}
                style={{
                  textAlign: "left",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--ink-3)",
                  padding: "6px 8px",
                }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((candidate) => {
            const rowDecision = decisions[candidate.id];
            const isDecided =
              rowDecision === "approved" || rowDecision === "rejected";
            return (
              <tr
                key={candidate.id}
                style={{
                  borderBottom: "1px solid var(--rule)",
                  opacity: isDecided ? 0.5 : 1,
                }}
              >
                <td style={{ padding: "10px 8px", maxWidth: 280 }}>
                  <div
                    style={{ fontWeight: 500, color: "var(--ink)", marginBottom: 2 }}
                  >
                    {extractProposalTitle(candidate.proposal)}
                  </div>
                </td>
                <td
                  style={{
                    padding: "10px 8px",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--wiki)",
                    maxWidth: 200,
                  }}
                >
                  {Array.isArray(candidate.sourcePageRefs)
                    ? candidate.sourcePageRefs.slice(0, 2).join(", ")
                    : "—"}
                </td>
                <td
                  style={{
                    padding: "10px 8px",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--ink-3)",
                  }}
                >
                  {new Date(candidate.createdAt).toLocaleDateString()}
                </td>
                <td style={{ padding: "10px 8px" }}>
                  {isDecided ? (
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        color:
                          rowDecision === "approved"
                            ? "var(--healthy)"
                            : "var(--ink-3)",
                      }}
                    >
                      {rowDecision}
                    </span>
                  ) : rowDecision === "conflict" ? (
                    <span
                      style={{ fontSize: 12, color: "var(--advisory-ink)" }}
                    >
                      {t("review.candidates.conflict")}
                    </span>
                  ) : rowDecision === "error" ? (
                    <span
                      style={{ fontSize: 12, color: "var(--alert)" }}
                    >
                      {t("common.error")}
                    </span>
                  ) : (
                    <span style={{ display: "flex", gap: 8 }}>
                      <Btn
                        variant="primary"
                        onClick={(): void => {
                          void handleDecision(candidate.id, "approve");
                        }}
                      >
                        {t("review.candidates.approve")}
                      </Btn>
                      <Btn
                        variant="ghost"
                        onClick={(): void => {
                          void handleDecision(candidate.id, "reject");
                        }}
                      >
                        {t("review.candidates.reject")}
                      </Btn>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
