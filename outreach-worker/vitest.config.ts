import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      // src/index.ts is the MCP entry point — it runs `await main()` at module
      // import time, which fights vitest's coverage collection. It's exercised
      // by the build pipeline + the startup smoke (npm run smoke:live). The
      // tools/ block has block-level integration tests in tests/tools/ rather
      // than per-file coverage; the thresholds below reflect what's measured
      // on the layers that ARE unit-tested (auth, api, schema, config, logger,
      // errors), where coverage is 90%+. Per-tool coverage expansion is v0.2.
      exclude: ["src/**/*.d.ts", "src/index.ts", "src/tools/**"],
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
        statements: 85,
      },
    },
    reporters: ["default"],
  },
});
