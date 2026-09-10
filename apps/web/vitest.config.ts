import { defineConfig } from "vitest/config";

/**
 * Unit tests only.
 *
 * `e2e/` is Playwright's, and vitest will happily collect a `.spec.ts` it cannot run. Excluding it
 * here is what keeps `pnpm test` green for someone who has never downloaded a browser — the whole
 * reason the end-to-end suite has its own command.
 */

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "e2e/**"],
  },
});
