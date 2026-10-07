// Minimal, non-opinionated lint for the pnpm workspace (apps/*, packages/*).
// Conservative on purpose: catches real bugs (unused vars, undeclared globals,
// unreachable code) without imposing a style opinion. No import ordering, no
// Prettier integration (the repo has no Prettier config).
//
// ponytail: no type-aware linting (needs a project service + full type graph,
// slow in CI). Add `recommendedTypeChecked` when a bug class requires it.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/*.d.ts",
      "**/.vercel/**",
      "contracts/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // live integration tests run as plain ESM under node --test
    files: ["**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Allow intentionally unused args/vars when prefixed with `_`.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // `no-undef` is redundant for TS (the compiler already checks it) and
      // produces false positives on type-only globals; tseslint disables it.
      "no-undef": "off",
      // Opinionated, not a bug class. 298 pre-existing hits repo-wide; enabling
      // it by default would bury the real findings. Turn on per-package when
      // tightening types deliberately.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
