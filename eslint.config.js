// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

/** Characters that may appear as JSX text without t() (punctuation, separators). */
const allowedJsxStrings = ['·', '•', '…', '/', '\\', '|', '–', '—', '-', ':', '%', '(', ')', '×', '+'];

const noServerInWeb = {
  regex: String.raw`^(?:\.\./)+server(?:/|$)|^@server(?:/|$)`,
  message: 'src/web must never import server code (CLAUDE.md: Web ↛ Server). Use @shared contracts.',
};
const serverOnlyPackages = {
  regex: String.raw`^(?:node:|fastify$|@fastify/|pino(?:-|$)|ws$|@anthropic-ai/)`,
  message: 'Server-only module. The web UI talks to the server via the WS/HTTP protocol (@shared).',
};
const noWebInServer = {
  regex: String.raw`^(?:\.\./)+web(?:/|$)|^@web(?:/|$)`,
  message: 'src/server must never import web code (CLAUDE.md: Server ↛ Web).',
};
const webOnlyPackages = {
  regex: String.raw`^(?:react|react-dom|radix-ui|lucide-react|zustand|virtua|shiki|streamdown|react-markdown)(?:/|$)`,
  message: 'Web-only module in server code.',
};
const sharedIsLeaf = {
  regex: String.raw`^(?:\.\./)+(?:server|web)(?:/|$)|^@(?:server|web)(?:/|$)`,
  message: 'src/shared is a leaf: it must not import server or web code.',
};

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    'dist/**',
    'coverage/**',
    '.tsbuild/**',
    'playwright-report/**',
    'test-results/**',
    'blob-report/**',
    '.parallax-dev/**',
    '.recordings/**',
    '.worktrees/**',
    '.claude/**',
  ]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      eqeqeq: ['error', 'always'],
    },
  },

  // Plain JS files (this config) are not part of a tsconfig project.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Application code: logging only via `logger`, never console.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: { 'no-console': 'error' },
  },

  // Import boundaries (also enforced by tsconfig rootDir + project references).
  {
    files: ['src/web/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [noServerInWeb, serverOnlyPackages] }] },
  },
  {
    files: ['src/server/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [noWebInServer, webOnlyPackages] }] },
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [sharedIsLeaf, serverOnlyPackages, webOnlyPackages] }],
    },
  },

  // React (web only). UI strings only via t(): react/jsx-no-literals.
  {
    files: ['src/web/**/*.{ts,tsx}'],
    extends: [
      react.configs.flat.recommended,
      react.configs.flat['jsx-runtime'],
      reactHooks.configs.flat.recommended,
    ],
    settings: { react: { version: 'detect' } },
    rules: {
      'react/prop-types': 'off',
      'react/jsx-no-literals': [
        'error',
        { noStrings: true, ignoreProps: true, allowedStrings: allowedJsxStrings },
      ],
    },
  },
  {
    files: ['src/web/**/*.test.{ts,tsx}'],
    rules: { 'react/jsx-no-literals': 'off' },
  },

  // Must stay last: turns off rules that conflict with Prettier.
  prettier,
]);
