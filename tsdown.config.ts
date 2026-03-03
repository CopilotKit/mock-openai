import { defineConfig } from "tsdown";
export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  target: "es2022",
  clean: true,
  unbundle: true,
});
