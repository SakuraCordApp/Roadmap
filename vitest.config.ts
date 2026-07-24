import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", "dist/**", "**/dist-types/**"],
    coverage: {
      reporter: ["text", "json", "html"],
      include: ["packages/*/src/**/*.ts", "apps/worker/src/**/*.ts"],
    },
  },
});
