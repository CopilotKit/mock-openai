import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    silent: true,
    include: ["src/__tests__/**/*.test.ts"],
  },
});
