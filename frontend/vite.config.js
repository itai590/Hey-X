import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function normalizeViteBase(raw) {
  const u = (raw || '/').trim();
  if (!u || u === '/') return '/';
  const trimmed = u.replace(/\/+$/, '');
  return `${trimmed}/`;
}

export default defineConfig(({ mode, command }) => {
  const prodBase = normalizeViteBase(process.env.PUBLIC_URL || '/');
  // If shell/.env sets PUBLIC_URL for Docker, dev server must still use `/` or
  // React Router basename won't match `http://localhost:5173/` and the tree renders nothing.
  const base =
    command === 'serve' && mode === 'development' ? '/' : prodBase;

  return {
    base,
    plugins: [react()],
    server: {
      // Proxy replaces CRA's "proxy" field in package.json.
      proxy: {
        '/api': 'http://localhost:5100',
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/setupTests.js'],
      css: true,
    },
  };
});
