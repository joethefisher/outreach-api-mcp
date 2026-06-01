// ESLint flat config — type-checked + strict + security + import discipline.
// The standards this enforces are documented in /STANDARDS.md.

import importPlugin from "eslint-plugin-import";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  {
    // Type-checked rules apply ONLY to TS source. JS config files (this
    // file, prettier configs) are linted with disable-type-checked below.
    files: ["**/*.ts"],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      import: importPlugin,
      security,
    },
    rules: {
      // ─── Production-grade TS ────────────────────────────────────────────────
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      // ─── No accidental stdout pollution (MCP stdio safety) ──────────────────
      // Use the structured logger; it writes to stderr. console.* in production
      // paths would corrupt the MCP transport.
      "no-console": "error",

      // ─── Dynamic-code execution forbidden ────────────────────────────────────
      "no-eval": "error",
      "no-new-func": "error",
      "no-implied-eval": "error",
      "security/detect-eval-with-expression": "error",
      "security/detect-non-literal-require": "error",
      "security/detect-pseudoRandomBytes": "error",
      "security/detect-bidi-characters": "error",

      // ─── No default exports — named only ─────────────────────────────────────
      "import/no-default-export": "error",
      "import/no-cycle": ["error", { maxDepth: 10 }],
      // Split parent/sibling/index into separate ordered groups so the
      // `.` vs `/` collation that varies across ICU/Node versions does not
      // affect import order (NEW-7). Within each group, alphabetize.
      "import/order": [
        "error",
        {
          groups: [["builtin", "external"], "internal", "parent", "sibling", "index"],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],

      // ─── Equality & control flow ─────────────────────────────────────────────
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-implicit-coercion": "error",
      "no-throw-literal": "error",
    },
  },
  {
    // Scripts and tests are TS but get console.* and default-export leniency.
    files: ["scripts/**/*.ts", "tests/**/*.ts", "vitest.config.ts"],
    rules: {
      "no-console": "off",
      "import/no-default-export": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // JS config files (this file, prettier configs): no type-checked rules,
    // no project lookup. Just basic JS hygiene.
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
