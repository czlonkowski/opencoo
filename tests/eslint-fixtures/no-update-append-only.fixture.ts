// Negative-case fixture for opencoo/no-update-append-only.
// The UPDATE and DELETE calls target `pageCitations` and
// `erasureLog` — both append-only per THREAT-MODEL §2
// invariant 8 (no carve-out). The rule must flag each call
// site.
//
// `agentRuns` is intentionally NOT in this fixture: PR 19 /
// plan #87 Q11 carved it out of the rule for the harness
// terminal-status UPDATE path. The runtime guard
// (`WHERE status = 'running'`) and one-time-mutation
// invariant are pinned by tests in the agent-harness suite.
//
// `db` and the table identifiers are declared locally so the
// fixture is self-contained. The rule matches on the
// CallExpression shape (method name + first-argument
// Identifier name), not on the type of the caller, so these
// stub declarations are sufficient.

declare const db: {
  update: (t: unknown) => { set: (v: unknown) => void; where: (v: unknown) => void };
  delete: (t: unknown) => void;
  with: (c: unknown) => {
    update: (t: unknown) => { set: (v: unknown) => void };
  };
};
declare const cte: unknown;
declare const erasureLog: unknown;
declare const pageCitations: unknown;

db.update(pageCitations).set({ pagePath: "x" });
db.delete(pageCitations);
db.with(cte).update(erasureLog).set({ targetRef: "x" });
