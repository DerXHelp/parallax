import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { PRODUCT_NAME } from './src/shared/product.ts';
import {
  BUILD_ID_DEFINE,
  DEV_SERVER_PORT,
  DEV_WEB_PORT,
  repoAliases,
  resolveBuildId,
  worktreeGlobs,
} from './repo.config.ts';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/** Injects the product name into index.html so it is defined in one place only. */
function productName(): Plugin {
  return {
    name: 'parallax:product-name',
    transformIndexHtml: (html) => html.replaceAll('%PARALLAX_PRODUCT_NAME%', PRODUCT_NAME),
  };
}

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
    port: DEV_WEB_PORT,
    strictPort: true,
    // All server routes live under /api (HTTP and the WebSocket endpoint, e.g. /api/ws).
    proxy: {
      '/api': { target: `http://127.0.0.1:${String(DEV_SERVER_PORT)}`, ws: true },
    },
    watch: {
      ignored: [...worktreeGlobs, '**/dist/**', '**/.tsbuild/**'],
    },
  },
  build: {
    outDir: path.join(repoRoot, 'dist/web'),
    emptyOutDir: true,
    sourcemap: true,
  },
}));
