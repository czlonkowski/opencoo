import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Vitest config — JSDOM environment for component tests; the
 * Playwright e2e suite runs separately via `pnpm test:e2e`.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/unit/setup.ts"],
    testTimeout: 15_000,
  },
});
