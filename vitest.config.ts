import { defineConfig } from "vitest/config";

export default defineConfig({
  // The tests run as a test build, so they cover test mode (src/shared/build.d.ts).
  define: { __TEST_BUILD__: "true" },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
