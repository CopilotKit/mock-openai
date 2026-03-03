import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  { ignores: ["dist/", "node_modules/", "fixtures/"] },
  {
    files: ["*.config.{js,mjs,ts}", "commitlint.config.js"],
    languageOptions: { globals: { module: "readonly", require: "readonly" } },
  },
);
