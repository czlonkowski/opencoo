/**
 * NewOutputChannelModal — Outputs tab `+ New output channel` flow
 * (PR-Z4, phase-a appendix #12 G5).
 *
 * Renders the per-adapter form dynamically from the descriptor map
 * `/api/admin/adapters` returns under `outputAdapters[]`. The
 * operator picks an adapter, fills in the channel-config fields
 * (e.g. Asana `project_gid`) + the credential field(s) (e.g.
 * `asanaPersonalAccessToken`), and submits. The server validates,
 * encrypts the credential via the CredentialStore, INSERTs the row,
 * audits.
 *
 * Hard-nos honored: no gradients, no emoji, lowercase opencoo,
 * `--alert` reserved for destructive surfaces (we use ghost styling
 * for cancel). Mono labels match the design system.
 */
import { useEffect, useState, type CSSProperties, type FormEventHandler } from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "./Btn.js";
import { Modal } from "./Modal.js";
import { ApiValidationError, fetchAdmin, fetchOptsFor } from "../lib/api.js";
import type { OutputAdapterEntry } from "../types.js";

export interface NewOutputChannelModalProps {
  readonly onCreated: () => void;
  readonly onClose: () => void;
  /** @internal Test seam. */
  readonly fetchImpl?: typeof fetch;
}

interface AdaptersResponse {
  readonly outputAdapters: readonly OutputAdapterEntry[];
}

export function NewOutputChannelModal(
  props: NewOutputChannelModalProps,
): JSX.Element {
  const { t } = useTranslation();
  const [adapters, setAdapters] = useState<readonly OutputAdapterEntry[]>([]);
  const [adapterSlug, setAdapterSlug] = useState<string>("");
  const [name, setName] = useState("");
  const [configFields, setConfigFields] = useState<Record<string, string>>({});
  const [credentialFields, setCredentialFields] = useState<
    Record<string, string>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const opts = fetchOptsFor(props.fetchImpl);

  useEffect((): void => {
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<AdaptersResponse>(
          "/api/admin/adapters",
          opts,
        );
        setAdapters(r.outputAdapters);
        if (r.outputAdapters.length > 0) {
          const first = r.outputAdapters[0]!;
          setAdapterSlug(first.slug);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const selected = adapters.find((a) => a.slug === adapterSlug);

  const onSubmit: FormEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const config: Record<string, unknown> = {};
      if (selected !== undefined) {
        for (const key of Object.keys(selected.channelConfigSchema.properties)) {
          const v = configFields[key];
          if (v !== undefined && v.length > 0) {
            config[key] = v;
          }
        }
      }
      const credentials: Record<string, unknown> = {};
      if (selected !== undefined) {
        for (const key of Object.keys(selected.credentialSchema.properties)) {
          const v = credentialFields[key];
          if (v !== undefined && v.length > 0) {
            credentials[key] = v;
          }
        }
      }
      await fetchAdmin("/api/admin/output-channels", {
        method: "POST",
        body: {
          adapter_slug: adapterSlug,
          name,
          config,
          credentials,
        },
        ...opts,
      });
      props.onCreated();
    } catch (err) {
      if (err instanceof ApiValidationError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const labelStyle: CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--fs-micro)",
    color: "var(--ink-3)",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  };
  const inputStyle: CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--fs-mono)",
    padding: "6px 8px",
    border: "1px solid var(--rule)",
    borderRadius: 4,
    background: "var(--paper)",
  };

  return (
    <Modal onClose={props.onClose} title={t("outputs.create.title")}>
      <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="output-adapter" style={labelStyle}>
            {t("outputs.create.adapter")}
          </label>
          <select
            id="output-adapter"
            value={adapterSlug}
            onChange={(e): void => setAdapterSlug(e.target.value)}
            style={inputStyle}
          >
            {adapters.map((a) => (
              <option key={a.slug} value={a.slug}>
                {a.slug}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor="output-name" style={labelStyle}>
            {t("outputs.create.name")}
          </label>
          <input
            id="output-name"
            type="text"
            value={name}
            onChange={(e): void => setName(e.target.value)}
            placeholder={t("outputs.create.namePlaceholder")}
            style={inputStyle}
            required
          />
        </div>
        {selected !== undefined ? (
          <>
            <div style={{ paddingTop: 8, borderTop: "1px solid var(--rule)" }}>
              <div style={labelStyle}>{t("outputs.create.configSection")}</div>
            </div>
            {Object.entries(selected.channelConfigSchema.properties).map(
              ([key, prop]) => (
                <div
                  key={`config-${key}`}
                  style={{ display: "flex", flexDirection: "column", gap: 4 }}
                >
                  <label htmlFor={`config-${key}`} style={labelStyle}>
                    {key}
                    {selected.channelConfigSchema.required.includes(key)
                      ? " · required"
                      : ""}
                  </label>
                  {prop.description !== undefined ? (
                    <span
                      style={{
                        fontSize: "var(--fs-small)",
                        color: "var(--ink-3)",
                      }}
                    >
                      {prop.description}
                    </span>
                  ) : null}
                  {/* PR-W3 Copilot triage — `object`-typed entries are
                      documentation-only in v0.1 (e.g. webhook `headers`,
                      `retryPolicy`). Skip the `<input>` widget; the
                      description above explains the field and server-
                      side Zod still validates the shape when the
                      operator submits it through `config` JSON. */}
                  {prop.type !== "object" ? (
                    <input
                      id={`config-${key}`}
                      type="text"
                      value={configFields[key] ?? ""}
                      onChange={(e): void =>
                        setConfigFields((s) => ({
                          ...s,
                          [key]: e.target.value,
                        }))
                      }
                      style={inputStyle}
                    />
                  ) : null}
                </div>
              ),
            )}
            <div style={{ paddingTop: 8, borderTop: "1px solid var(--rule)" }}>
              <div style={labelStyle}>{t("outputs.create.credSection")}</div>
            </div>
            {Object.entries(selected.credentialSchema.properties).map(
              ([key, prop]) => (
                <div
                  key={`cred-${key}`}
                  style={{ display: "flex", flexDirection: "column", gap: 4 }}
                >
                  <label htmlFor={`cred-${key}`} style={labelStyle}>
                    {key}
                    {selected.credentialSchema.required.includes(key)
                      ? " · required"
                      : ""}
                  </label>
                  {prop.description !== undefined ? (
                    <span
                      style={{
                        fontSize: "var(--fs-small)",
                        color: "var(--ink-3)",
                      }}
                    >
                      {prop.description}
                    </span>
                  ) : null}
                  <input
                    id={`cred-${key}`}
                    type={prop.secret === true ? "password" : "text"}
                    value={credentialFields[key] ?? ""}
                    onChange={(e): void =>
                      setCredentialFields((s) => ({ ...s, [key]: e.target.value }))
                    }
                    style={inputStyle}
                  />
                </div>
              ),
            )}
          </>
        ) : null}
        {error !== null ? (
          <div
            role="alert"
            style={{
              color: "var(--alert)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-micro)",
            }}
          >
            {error}
          </div>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="ghost" type="button" onClick={props.onClose}>
            {t("outputs.create.cancel")}
          </Btn>
          <Btn variant="primary" type="submit" disabled={submitting}>
            {submitting ? t("outputs.create.saving") : t("outputs.create.submit")}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}
