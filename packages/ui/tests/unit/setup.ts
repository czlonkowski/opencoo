/**
 * Vitest setup — wires testing-library + i18n bootstrapping
 * for unit tests. Each test file gets the same i18n
 * initialisation so `useTranslation` works without re-init.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

import "../../src/lib/i18n.js";

afterEach(() => {
  cleanup();
});
