import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './index.css';

import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { PRODUCT_NAME } from '@shared/product';
import { App } from './App';
import { isPlaygroundHash } from './playground/route';
import { installShortcutListener } from './shell/shortcuts';
import { bootApp } from './state/bootstrap';
import { applyInitialTheme } from './state/theme';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Root element #root is missing in index.html');
}
const root = createRoot(rootElement);

function render(node: ReactNode): void {
  root.render(<StrictMode>{node}</StrictMode>);
}

document.title = PRODUCT_NAME;
applyInitialTheme();
installShortcutListener();

// Playground (#playground, dev server only): sample data over the in-memory transport, no server.
// In production builds `import.meta.env.DEV` is false and the playground is not bundled.
if (import.meta.env.DEV && isPlaygroundHash(window.location.hash)) {
  void import('./playground/PlaygroundApp').then(({ PlaygroundApp }) => {
    render(<PlaygroundApp />);
  });
} else {
  bootApp();
  render(<App />);
}
