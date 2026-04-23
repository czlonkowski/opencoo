import { ConsoleLogger, type LoggerWriteStream } from "../../src/logger.js";

// Shared no-op logger for tests whose assertions don't care about log
// output. Silences the stream entirely so test runs stay quiet; for
// tests that DO assert on log content, construct a `ConsoleLogger`
// with a capturing stream inline (see e.g.
// `credential-store-never-logs-plaintext.test.ts`).
export function nullLogger(): ConsoleLogger {
  const stream: LoggerWriteStream = {
    write(): boolean {
      return true;
    },
  };
  return new ConsoleLogger({ stream });
}
