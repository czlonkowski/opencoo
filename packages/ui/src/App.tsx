/**
 * Root App — Sidebar + TopBar + active tab + global flows
 * (PAT entry, debug banner, logout, Cmd-K palette).
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  CommandPalette,
  type CommandPaletteTarget,
} from "./components/CommandPalette.js";
import { DebugBanner } from "./components/DebugBanner.js";
import { Sidebar, TopBar } from "./components/Chrome.js";
import { PatEntryModal } from "./components/PatEntryModal.js";
import {
  ApiAuthError,
  fetchAdmin,
} from "./lib/api.js";
import { clearPat, getPat, setPat } from "./lib/pat-store.js";
import { Activity } from "./routes/Activity.js";
import { Agents } from "./routes/Agents.js";
import { Audit } from "./routes/Audit.js";
import { Cost } from "./routes/Cost.js";
import { Domains } from "./routes/Domains.js";
import { LlmPolicy } from "./routes/LlmPolicy.js";
import { Outputs } from "./routes/Outputs.js";
import { Prompts } from "./routes/Prompts.js";
import { Reports } from "./routes/Reports.js";
import { Review } from "./routes/Review.js";
import { Sources } from "./routes/Sources.js";
import type { Tab } from "./types.js";

interface CsrfResponse {
  readonly csrfToken: string;
  readonly username: string | null;
  readonly _llmDebugLogActive?: boolean;
}

/** Prompt roster surfaced by the Cmd-K palette. Mirrors the
 *  `PROMPT_NAMES` tuple in `packages/shared/src/prompts/loader.ts`.
 *  Duplicated here per the same rationale as `routes/Prompts.tsx`:
 *  the UI package keeps no `@opencoo/shared` runtime dependency,
 *  and adding a prompt is a one-line edit either way. The literal
 *  union is the source of truth for the `initialPromptName` prop
 *  the Prompts route accepts. */
const PALETTE_PROMPT_NAMES = [
  "classifier",
  "compiler",
  "heartbeat",
  "lint",
  "chat",
  "surfacer",
  "builder",
  "worldview-domain",
  "worldview-company",
] as const;
type PaletteName = (typeof PALETTE_PROMPT_NAMES)[number];

function isPaletteName(s: string): s is PaletteName {
  return (PALETTE_PROMPT_NAMES as readonly string[]).includes(s);
}

export function App(): JSX.Element {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("domains");
  const [authed, setAuthed] = useState<boolean>(() => getPat() !== null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [debugActive, setDebugActive] = useState<boolean>(false);
  // PR-W7a — when the operator clicks the "Prompts" affordance
  // in DomainDetail, we pre-select the domain in the Prompts
  // tab. The state is cleared once the Prompts route honors it
  // so subsequent manual selections persist.
  const [promptsInitialDomainId, setPromptsInitialDomainId] = useState<
    string | null
  >(null);
  // PR-W10 — Cmd-K palette navigation pre-selects a row inside
  // the destination tab. The Domains / Sources / Agents routes
  // accept an `initialOpenId` prop that resolves to the rows
  // table once the data lands and auto-opens the drill-down
  // modal. We track them as three separate states so a palette
  // jump to one route doesn't accidentally re-open a drill-down
  // on a different one.
  const [domainsOpenId, setDomainsOpenId] = useState<string | null>(null);
  const [sourcesOpenId, setSourcesOpenId] = useState<string | null>(null);
  const [agentsOpenId, setAgentsOpenId] = useState<string | null>(null);
  // PR-W10 — breadcrumb row-name. Each route lifts its selected
  // row's display label into this state via `onCrumbChange` so
  // the TopBar can render `<group> / <tab> / <row-name>`. Pages
  // without a drill-down (or with no row selected) pass null
  // and the bar renders the two-segment form.
  const [crumb, setCrumb] = useState<string | null>(null);
  // PR-W10 — Cmd-K palette open state. Cmd-K (mac) / Ctrl-K
  // (Linux/Win) toggles the palette; selection or Esc closes it.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // PR-W10 — Prompts route pre-select on a palette prompt-hop.
  // Distinct from `promptsInitialDomainId` (which seeds the
  // domain picker on a DomainDetail → Prompts hop); this state
  // seeds the prompt-name picker so Cmd-K → "Prompt: heartbeat"
  // lands on the heartbeat editor instead of the empty picker.
  // (Copilot triage on PR-W10.)
  const [promptsInitialName, setPromptsInitialName] = useState<string | null>(
    null,
  );

  const onNavigateToPrompts = (domainId: string): void => {
    setPromptsInitialDomainId(domainId);
    // `setTab` would unmount Domains before its `selected`-cleanup
    // effect publishes `null`, so clear the crumb inline. Same
    // crumb-clearing semantics as `navigateToTab`. (Copilot
    // triage on PR-W10.)
    setCrumb(null);
    setTab("prompts");
  };

  // Tab navigation must clear the row-level crumb — the row name
  // belongs to the route we're leaving. The destination route
  // re-publishes its own crumb (or null) once mounted.
  const navigateToTab = useCallback((next: Tab): void => {
    setTab(next);
    setCrumb(null);
  }, []);

  // Stable callback identity for child routes' effect dep lists
  // — without `useCallback` each parent re-render would re-fire
  // every route's onCrumbChange effect.
  const onCrumbChange = useCallback(
    (value: string | null): void => setCrumb(value),
    [],
  );

  // Palette dispatcher — maps a CommandPaletteTarget to the
  // existing setTab + initial-id plumbing. Domains/Sources/
  // Agents each get a dedicated pre-select state. Prompts honors
  // both the domain-hop channel (`promptsInitialDomainId`) and
  // the prompt-name channel (`promptsInitialName`) so Cmd-K →
  // "Prompt: heartbeat" actually lands on the heartbeat editor
  // rather than the empty picker (Copilot triage on PR-W10).
  const onPaletteNavigate = useCallback(
    (target: CommandPaletteTarget): void => {
      setDomainsOpenId(null);
      setSourcesOpenId(null);
      setAgentsOpenId(null);
      setPromptsInitialName(null);
      setCrumb(null);
      if (target.tab === "domains" && target.entityId !== undefined) {
        setDomainsOpenId(target.entityId);
      } else if (target.tab === "sources" && target.entityId !== undefined) {
        setSourcesOpenId(target.entityId);
      } else if (target.tab === "agents" && target.entityId !== undefined) {
        setAgentsOpenId(target.entityId);
      } else if (target.tab === "prompts" && target.promptName !== undefined) {
        setPromptsInitialName(target.promptName);
      }
      setTab(target.tab);
    },
    [],
  );

  // Consume-once callbacks for palette pre-select. Once a route
  // applies its `initialOpenId`, App clears the corresponding
  // state — closing the modal + switching away + returning no
  // longer re-opens the stale row (Copilot triage on PR-W10).
  const onDomainsOpenIdConsumed = useCallback(
    (): void => setDomainsOpenId(null),
    [],
  );
  const onSourcesOpenIdConsumed = useCallback(
    (): void => setSourcesOpenId(null),
    [],
  );
  const onAgentsOpenIdConsumed = useCallback(
    (): void => setAgentsOpenId(null),
    [],
  );
  const onPromptsNameConsumed = useCallback(
    (): void => setPromptsInitialName(null),
    [],
  );

  // Global Cmd-K (macOS) / Ctrl-K (Linux/Windows) listener. We
  // bind it once at the root so the palette opens regardless of
  // which tab has focus. The handler short-circuits when the
  // gating PatEntryModal is up — there's nothing to navigate to
  // until the operator's authed.
  //
  // Platform gate (Copilot triage on PR-W10): only `metaKey` on
  // macOS, only `ctrlKey` elsewhere. Without this, Ctrl-K on macOS
  // would steal the standard "delete to end of line" text-editing
  // shortcut every textarea in the console relies on.
  useEffect(() => {
    if (!authed) return;
    const isMac =
      typeof navigator !== "undefined" &&
      (navigator.platform ?? "").toLowerCase().includes("mac");
    const onKey = (e: KeyboardEvent): void => {
      const modifier = isMac ? e.metaKey : e.ctrlKey;
      if (modifier && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", onKey);
    return (): void => document.removeEventListener("keydown", onKey);
  }, [authed]);

  useEffect((): void => {
    if (!authed) return;
    void (async (): Promise<void> => {
      try {
        const r = await fetchAdmin<CsrfResponse>("/api/admin/_csrf");
        setUsername(r.username);
        setDebugActive(r._llmDebugLogActive === true);
        setAuthError(null);
      } catch (err) {
        // Both auth and non-auth failures must flip `authed: false`
        // so the PatEntryModal can render the error message and let
        // the operator retry. Prior shape only flipped on
        // ApiAuthError → on a transient/network failure the error
        // string was set but the modal stayed hidden.
        if (err instanceof ApiAuthError) {
          setAuthError(
            err.status === 403
              ? t("auth.forbidden")
              : t("auth.loginFailed"),
          );
        } else {
          setAuthError(t("auth.loginFailed"));
        }
        setAuthed(false);
        clearPat();
      }
    })();
  }, [authed, t]);

  const onPatSubmit = async (pat: string): Promise<void> => {
    setPat(pat);
    setAuthed(true);
  };

  const onLogout = async (): Promise<void> => {
    try {
      await fetchAdmin("/api/admin/logout", { method: "POST" });
    } catch {
      // Server-side logout is best-effort; we always clear
      // client state regardless.
    }
    clearPat();
    setAuthed(false);
    setUsername(null);
  };

  // PR-W3 — Activity feed signals a terminal SSE 401 (operator's PAT
  // is durably stale). Re-uses the existing PAT clear + sign-out flow:
  // dropping `authed` re-renders the gating PatEntryModal so the
  // operator can paste a fresh token. NO new auth flow here.
  const onSseAuthFailed = (): void => {
    clearPat();
    setAuthed(false);
    setUsername(null);
    setAuthError(t("auth.loginFailed"));
  };

  if (!authed) {
    return (
      <PatEntryModal
        onSubmit={onPatSubmit}
        {...(authError !== null ? { error: authError } : {})}
      />
    );
  }

  const tabs: Record<Tab, JSX.Element> = {
    domains: (
      <Domains
        onNavigateToPrompts={onNavigateToPrompts}
        onCrumbChange={onCrumbChange}
        onInitialOpenIdConsumed={onDomainsOpenIdConsumed}
        {...(domainsOpenId !== null ? { initialOpenId: domainsOpenId } : {})}
      />
    ),
    sources: (
      <Sources
        onCrumbChange={onCrumbChange}
        onInitialOpenIdConsumed={onSourcesOpenIdConsumed}
        {...(sourcesOpenId !== null ? { initialOpenId: sourcesOpenId } : {})}
      />
    ),
    agents: (
      <Agents
        onCrumbChange={onCrumbChange}
        onInitialOpenIdConsumed={onAgentsOpenIdConsumed}
        {...(agentsOpenId !== null ? { initialOpenId: agentsOpenId } : {})}
      />
    ),
    outputs: <Outputs />,
    llmPolicy: <LlmPolicy />,
    prompts: (
      <Prompts
        onInitialPromptNameConsumed={onPromptsNameConsumed}
        {...(promptsInitialDomainId !== null
          ? { initialDomainId: promptsInitialDomainId }
          : {})}
        {...(promptsInitialName !== null && isPaletteName(promptsInitialName)
          ? { initialPromptName: promptsInitialName }
          : {})}
      />
    ),
    activity: <Activity onAuthFailed={onSseAuthFailed} />,
    review: <Review />,
    reports: <Reports onNavigate={navigateToTab} />,
    audit: <Audit />,
    cost: <Cost />,
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--paper)",
      }}
    >
      <DebugBanner visible={debugActive} />
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <Sidebar tab={tab} setTab={navigateToTab} />
        <main
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "auto",
          }}
        >
          <TopBar
            tab={tab}
            {...(crumb !== null ? { crumb } : {})}
            username={username}
            onLogout={(): void => {
              void onLogout();
            }}
          />
          {tabs[tab]}
        </main>
      </div>
      {paletteOpen ? (
        <CommandPalette
          onClose={(): void => setPaletteOpen(false)}
          onNavigate={onPaletteNavigate}
          promptNames={PALETTE_PROMPT_NAMES}
        />
      ) : null}
    </div>
  );
}
