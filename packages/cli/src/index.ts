/**
 * Public surface for `@opencoo/cli` (PR 30 / plan #135).
 *
 * The bin entry (`bin.js` in the published package) calls
 * `runMain` with `process.argv.slice(2)`. Tests instead call
 * the per-command runners directly with mocked args — the
 * commander parse layer is exercised once via the
 * `parseAndDispatch` test, the per-command behavior via
 * direct invocation.
 */
export { parseAndDispatch } from "./parse.js";
export { runMigrate, type MigrateArgs } from "./commands/migrate.js";
export { runSetup, type SetupArgs } from "./commands/setup.js";
export {
  runDoctor,
  type DoctorArgs,
  type DoctorReport,
  type DoctorCheck,
  type DoctorCheckLevel,
} from "./commands/doctor.js";
export {
  runSourceTest,
  type SourceTestArgs,
} from "./commands/source-test.js";
export {
  runSourceForget,
  type SourceForgetArgs,
} from "./commands/source-forget.js";
export {
  runRecompile,
  type RecompileArgs,
} from "./commands/recompile.js";
export {
  inspectSecret,
  formatSecret,
  type RedactedSecret,
} from "./lib/credential-redact.js";
export {
  ExitSentinel,
  isExitSentinel,
  EXIT_OK,
  EXIT_USER_ERROR,
  EXIT_RUNTIME_ERROR,
} from "./lib/exit.js";
