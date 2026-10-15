import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { PRODUCT_NAME } from './src/shared/product.ts';
import {
  BUILD_ID_DEFINE,
  DEV_SERVER_PORT,
  devWebPort,
  repoAliases,
  resolveBuildId,
  watchIgnores,
} from './repo.config.ts';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/** Injects the product name into index.html so it is defined in one place only. */
function productName(): Plugin {
  return {
    name: 'parallax:product-name',
    transformIndexHtml: (html) => html.replaceAll('%PARALLAX_PRODUCT_NAME%', PRODUCT_NAME),
  };
}

/** Modules of the start bundle from node_modules (`$initial`: lazy imports keep their own chunks). */
const NODE_MODULES = /[\\/]node_modules[\\/]/;
const REACT_RUNTIME = /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/;

export default defineConfig(({ command }) => ({
  root: path.join(repoRoot, 'src/web'),
  plugins: [react(), tailwindcss(), productName()],
  // Same build id as the server bundle (scripts/build-server.ts); the dev server keeps 'dev'.
  define: command === 'build' ? { [BUILD_ID_DEFINE]: JSON.stringify(resolveBuildId(repoRoot)) } : {},
  resolve: {
    alias: repoAliases(repoRoot),
  },
  server: {
    host: '127.0.0.1',
    // PARALLAX_DEV_WEB_PORT=5175 pnpm dev:web → own port per worktree (playground, ADR-030).
    port: devWebPort(),
    strictPort: true,
    // All server routes live under /api (HTTP and the WebSocket endpoint, e.g. /api/ws).
    proxy: {
      '/api': { target: `http://127.0.0.1:${String(DEV_SERVER_PORT)}`, ws: true },
    },
    watch: {
      // Anchored at this checkout (R1W-01): relative globs would hide every file of a worktree.
      ignored: watchIgnores(repoRoot),
    },
  },
  build: {
    outDir: path.join(repoRoot, 'dist/web'),
    emptyOutDir: true,
    sourcemap: true,
    // Fonts and other assets always as files: the page CSP (default-src 'self') blocks data: fonts (V1-02).
    assetsInlineLimit: 0,
    // The 500 kB warning stays as a guard (R1W-09, ADR-035): React and the other start-up
    // libraries get their own long-lived chunks; dynamic import() (Markdown, Shiki, diff in WP-15)
    // keeps separate lazy chunks because only `$initial` modules are grouped.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: REACT_RUNTIME, tags: ['$initial'], priority: 2 },
            { name: 'vendor', test: NODE_MODULES, tags: ['$initial'], priority: 1 },
          ],
        },
      },
    },
  },
}));
