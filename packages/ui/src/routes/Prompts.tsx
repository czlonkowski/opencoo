/**
 * Prompts tab — read-only listing of every prompt-name + locale
 * + version shipped with this build (PR 29 / plan #131,
 * decision Q5/Q6).
 *
 * The version source of truth is `@opencoo/shared/prompts`'s
 * new `version-manifest.ts` const map. The endpoint
 * `/api/admin/prompts` returns it shaped per
 * `PromptManifestEntry`.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Card } from "../components/Card.js";
import { PromptsDiffBanner } from "../components/PromptsDiffBanner.js";
import { fetchAdmin } from "../lib/api.js";
import type { PromptManifestEntry } from "../types.js";

interface PromptsResponse {
  readonly entries: ReadonlyArray<PromptManifestEntry>;
}

export function Prompts(): JSX.Element {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<ReadonlyArray<PromptManifestEntry> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect((): void => {
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<PromptsResponse>("/api/admin/prompts");
        setEntries(r.entries);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  return (
    <div style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ margin: 0 }}>{t("prompts.title")}</h1>
        <p style={{ margin: "4px 0 0", color: "var(--ink-3)" }}>{t("prompts.subtitle")}</p>
      </div>
      {/* PromptsDiffBanner mounts with empty `lagging` for v0.1
       *  — no per-domain prompt overrides yet, so no drift to
       *  surface. The component stays here so the day overrides
       *  ship the wiring is one passed-prop away. */}
      <PromptsDiffBanner lagging={[]} />
      <Card>
        {error !== null ? (
          <div style={{ color: "var(--alert)" }}>{error}</div>
        ) : entries === null ? (
          <div style={{ color: "var(--ink-3)" }}>{t("common.loading")}</div>
        ) : entries.length === 0 ? (
          <div style={{ color: "var(--ink-3)" }}>{t("prompts.empty")}</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 0.4fr 0.6fr", gap: 12 }}>
            <div className="t-micro">{t("prompts.columns.name")}</div>
            <div className="t-micro">{t("prompts.columns.locale")}</div>
            <div className="t-micro">{t("prompts.columns.version")}</div>
            {entries.flatMap((e) =>
              e.locales.map((l) => (
                <div key={`${e.name}-${l.locale}`} style={{ display: "contents" }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-mono)" }}>{e.name}</div>
                  <div style={{ color: "var(--ink-3)" }}>{l.locale}</div>
                  <div style={{ color: "var(--wiki)", fontFamily: "var(--font-mono)" }}>{l.version}</div>
                </div>
              )),
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
