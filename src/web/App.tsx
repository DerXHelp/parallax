import { Layers } from 'lucide-react';
import { PRODUCT_NAME } from '@shared/product';

/**
 * Minimal app stub from WP-00. WP-14 replaces it with the real shell
 * (WS client, stores, theme, i18n). UI strings only via t() – see CLAUDE.md.
 */
export function App() {
  return (
    <main className="bg-background text-foreground flex h-full items-center justify-center gap-3">
      <Layers aria-hidden className="text-primary size-6" />
      <h1 className="font-mono text-xl font-semibold tracking-tight">{PRODUCT_NAME}</h1>
    </main>
  );
}
