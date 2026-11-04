import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone Vitest config (kept separate from vite.config.js so unit tests run
// without the SvelteKit plugin / SSR machinery). Targets the pure helpers under
// tests/unit.
export default defineConfig({
  resolve: {
    // Library modules import each other with SvelteKit's `$lib` alias; mirror
    // it here so those modules can be unit tested directly.
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
