const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  js.configs.recommended,
  {
    languageOptions: { sourceType: "commonjs", ecmaVersion: 2023, globals: { ...globals.node } },
    rules: {
      // `_x` args and unused caught errors are fine; everything else unused is flagged
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  { ignores: ["node_modules/**", "seed/*.json"] },
];
