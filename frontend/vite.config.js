import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { demoApiPlugin } from './dev-demo-api';

function normalizeViteBase(raw) {
  const u = (raw || '/').trim();
  if (!u || u === '/') return '/';
  const trimmed = u.replace(/\/+$/, '');
  return `${trimmed}/`;
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const prodBase = normalizeViteBase(process.env.PUBLIC_URL || '/');
  // If shell/.env sets PUBLIC_URL for Docker, dev server must still use `/` or
  // React Router basename won't match `http://localhost:5173/` and the tree renders nothing.
  const base =
    command === 'serve' && mode === 'development' ? '/' : prodBase;

  const demoMode = env.VITE_DEMO_MODE === 'true';
  const plugins = [react()];
  if (demoMode) {
    plugins.push(demoApiPlugin({
      adminToken: env.VITE_DEMO_ADMIN_TOKEN || 'hey-demo-admin',
      repoRoot: path.resolve(process.cwd(), '..'),
      timeZone: env.VITE_DEMO_TIME_ZONE || 'UTC',
    }));
  }

  return {
    base,
    plugins,
    server: {
      // Proxy replaces CRA's "proxy" field in package.json.
      proxy: demoMode ? undefined : {
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
