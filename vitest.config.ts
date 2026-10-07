import { defineConfig } from "vitest/config";

export default defineConfig({
  // The tests run as a test build, so they cover test mode (src/shared/build.d.ts).
  define: { __TEST_BUILD__: "true", __BUILD_COMMIT__: JSON.stringify("test") },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
