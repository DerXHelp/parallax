// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

/** Characters that may appear as JSX text without t() (punctuation, separators). */
const allowedJsxStrings = ['·', '•', '…', '/', '\\', '|', '–', '—', '-', ':', '%', '(', ')', '×', '+'];

// ---- import boundaries (no-restricted-imports; ADR-034) ----
// A later flat-config block REPLACES the options of an earlier one for the same file, so every
// block below lists all patterns that apply to its files.

/** Node built-ins, with or without the `node:` prefix (R0-22). */
const NODE_BUILTINS = [
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
];
const nodeBuiltinRegex = String.raw`^(?:node:|(?:${NODE_BUILTINS.join('|')})(?:/|$))`;
const serverPackageRegex = String.raw`^(?:fastify$|@fastify/|pino(?:-|$)|ws$|@anthropic-ai/)`;
const webPackageRegex = String.raw`^(?:react|react-dom|radix-ui|@radix-ui/[^/]+|lucide-react|zustand|virtua|shiki|@shikijs/[^/]+|streamdown|react-markdown)(?:/|$)`;

const noServerInWeb = {
  regex: String.raw`^(?:\.\./)+server(?:/|$)|^@server(?:/|$)`,
  message: 'src/web must never import server code (CLAUDE.md: Web ↛ Server). Use @shared contracts.',
};
const serverOnlyPackages = {
  regex: serverPackageRegex,
  message: 'Server-only module. The web UI talks to the server via the WS/HTTP protocol (@shared).',
};
const nodeBuiltinsInWeb = {
  regex: nodeBuiltinRegex,
  message: 'Node built-in in web code. The web UI runs in the browser; talk to the server via @shared.',
};
const noWebInServer = {
  regex: String.raw`^(?:\.\./)+web(?:/|$)|^@web(?:/|$)`,
  message: 'src/server must never import web code (CLAUDE.md: Server ↛ Web).',
};
const webOnlyPackages = {
  regex: webPackageRegex,
  message: 'Web-only module in server code.',
};
const sharedIsLeaf = {
  regex: String.raw`^(?:\.\./)+(?:server|web)(?:/|$)|^@(?:server|web)(?:/|$)`,
  message: 'src/shared is a leaf: it must not import server or web code.',
};
const nodeBuiltinsInShared = {
  regex: nodeBuiltinRegex,
  message: 'src/shared is isomorphic (server and web): no Node built-ins, with or without "node:".',
};
const serverPackagesInShared = {
  regex: serverPackageRegex,
  message: 'src/shared is isomorphic (server and web): no server-only packages – only zod.',
};
const webPackagesInShared = {
  regex: webPackageRegex,
  message: 'src/shared is isomorphic (server and web): no web-only packages – only zod.',
};

/** Direct Radix imports only in src/web/ui (architecture §2.3b). */
const radixOnlyInUi = {
  regex: String.raw`^(?:radix-ui|@radix-ui/)`,
  message: 'Use the primitives from src/web/ui (radix-ui is imported only there).',
};
/** Features never import each other (R1W-08, ADR-017). */
const featureBoundary = (/** @type {string[]} */ others) => ({
  regex: String.raw`^(?:@web/features/|(?:\.\./)+(?:features/)?)(?:${others.join('|')})(?:/|$)`,
  message:
    'Features never import each other – share components through the FeatureSlots (src/web/shell/slots.tsx).',
});
/** Shell, state, lib, ui and playground never import features (WP-20 wires them in App.tsx). */
const noFeaturesInCore = {
  regex: String.raw`^(?:@web/|(?:\.\./)+)features(?:/|$)`,
  message:
    'Core code never imports features: they plug in through the FeatureSlots (App.tsx); feature demos come via import.meta.glob.',
};
/** i18n registers the feature dictionaries and nothing else of a feature. */
const onlyFeatureDictionaries = {
  regex: String.raw`^(?:@web/|(?:\.\./)+)features(?!/[a-z0-9-]+/i18n/(?:en|de)$)(?:/|$)`,
  message: 'src/web/i18n imports only the feature dictionaries (features/<f>/i18n/{en,de}).',
};
/** Features read the store through the hooks; only state/* writes it (R1W-08). */
const noStoreWriters = {
  regex: String.raw`(?:^@web/|/)state/store$`,
  importNames: ['clientStore', 'updateHost', 'updateSession', 'removeSessions', 'resetClientStore'],
  message:
    'Read client state through @web/state/hooks (useSessionSelector, useSessionMeta …); only src/web/state writes the store.',
};

const webBase = [noServerInWeb, serverOnlyPackages, nodeBuiltinsInWeb];
/** @param {object[]} patterns */
const restrictImports = (patterns) => ({ 'no-restricted-imports': ['error', { patterns }] });

/** Feature folders (Phase 2: + profiles, preferences – WP-30 §4.14 C). */
const FEATURES = ['transcript', 'decisions', 'composer', 'profiles', 'preferences'];
/** Every feature except the given ones (a feature group may import its own members). */
const otherFeatures = (/** @type {string[]} */ own) => FEATURES.filter((f) => !own.includes(f));

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

  // Import boundaries (also enforced by tsconfig rootDir + project references). Order matters:
  // the most specific block comes last (it replaces the options of the earlier ones).
  {
    files: ['src/web/**/*.{ts,tsx}'],
    rules: restrictImports([...webBase, radixOnlyInUi]),
  },
  {
    files: ['src/web/ui/**/*.{ts,tsx}'],
    rules: restrictImports([...webBase, noFeaturesInCore]),
  },
  {
    // R3-09: notifications/ is core code too (no features, no radix).
    files: ['src/web/{shell,state,lib,playground,notifications}/**/*.{ts,tsx}'],
    rules: restrictImports([...webBase, radixOnlyInUi, noFeaturesInCore]),
  },
  {
    files: ['src/web/i18n/**/*.{ts,tsx}'],
    rules: restrictImports([...webBase, radixOnlyInUi, onlyFeatureDictionaries]),
  },
  {
    files: ['src/web/features/transcript/**/*.{ts,tsx}'],
    rules: restrictImports([
      ...webBase,
      radixOnlyInUi,
      noStoreWriters,
      featureBoundary(otherFeatures(['transcript'])),
    ]),
  },
  {
    // decisions ↔ composer both belong to WP-16.
    files: ['src/web/features/{decisions,composer}/**/*.{ts,tsx}'],
    rules: restrictImports([
      ...webBase,
      radixOnlyInUi,
      noStoreWriters,
      featureBoundary(otherFeatures(['decisions', 'composer'])),
    ]),
  },
  {
    // Phase 2 features (WP-36, WP-38).
    files: ['src/web/features/profiles/**/*.{ts,tsx}'],
    rules: restrictImports([
      ...webBase,
      radixOnlyInUi,
      noStoreWriters,
      featureBoundary(otherFeatures(['profiles'])),
    ]),
  },
  {
    files: ['src/web/features/preferences/**/*.{ts,tsx}'],
    rules: restrictImports([
      ...webBase,
      radixOnlyInUi,
      noStoreWriters,
      featureBoundary(otherFeatures(['preferences'])),
    ]),
  },
  {
    // Feature tests may reset/inspect the store (resetClientStore in afterEach).
    files: ['src/web/features/transcript/**/*.test.{ts,tsx}'],
    rules: restrictImports([...webBase, radixOnlyInUi, featureBoundary(otherFeatures(['transcript']))]),
  },
  {
    files: ['src/web/features/{decisions,composer}/**/*.test.{ts,tsx}'],
    rules: restrictImports([
      ...webBase,
      radixOnlyInUi,
      featureBoundary(otherFeatures(['decisions', 'composer'])),
    ]),
  },
  {
    files: ['src/web/features/profiles/**/*.test.{ts,tsx}'],
    rules: restrictImports([...webBase, radixOnlyInUi, featureBoundary(otherFeatures(['profiles']))]),
  },
  {
    files: ['src/web/features/preferences/**/*.test.{ts,tsx}'],
    rules: restrictImports([...webBase, radixOnlyInUi, featureBoundary(otherFeatures(['preferences']))]),
  },
  {
    files: ['src/server/**/*.ts'],
    rules: restrictImports([noWebInServer, webOnlyPackages]),
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: restrictImports([sharedIsLeaf, nodeBuiltinsInShared, serverPackagesInShared, webPackagesInShared]),
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
