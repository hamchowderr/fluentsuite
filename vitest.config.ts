import { defineConfig } from "vitest/config";

// Vite's default server conditions, prefixed with ours.
const conditions = ["@fluentsuite/source", "module", "node", "development|production"];

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources, so tests never need a build.
  resolve: { conditions: conditions },
  ssr: { resolve: { conditions: conditions } },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./vitest.setup.ts"],
    testTimeout: 15_000,
  },
});
