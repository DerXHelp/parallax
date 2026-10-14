import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PRODUCT_NAME } from '@shared/product';
import { App } from './App';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Root element #root is missing in index.html');
}

document.title = PRODUCT_NAME;

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
