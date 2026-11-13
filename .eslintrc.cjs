/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2023, sourceType: 'module', project: './tsconfig.json' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2023: true },
  ignorePatterns: ['node_modules', 'dist', 'coverage', '*.cjs', '**/generated/**'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    // [check:money] K01-T02 — loaded from tools/eslint-rules via --rulesdir
    'no-number-money': 'error',
  },
  overrides: [
    {
      files: ['tools/**/*.ts', 'tests/**/*.ts', 'tools/demo/**/*.ts'],
      rules: { 'no-console': 'off', 'no-number-money': 'off' },
    },
    {
      // The Money value object is the single place allowed to reason about decimals.
      files: ['libs/shared/src/money.ts'],
      rules: { 'no-number-money': 'off' },
    },
  ],
};
