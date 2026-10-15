import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts", "eval/src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
