import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { devBroker } from './dev-broker';

export default defineConfig(({ command, mode }) => {
  const serve = command === 'serve';
  // Load ALL vars from .env (no VITE_ prefix filter) for the Node-side dev broker.
  // These stay server-side — they are NOT exposed to the browser (no `define`).
  const env = serve ? loadEnv(mode, process.cwd(), '') : {};

  return {
    plugins: [react(), ...(serve ? [devBroker(env)] : [])],
    root: 'ui',
    // Dev (`npm run dev`): alias the SDK to a functional local mock (ui/sdk-dev.ts)
    // that runs the real backend.ts and routes owox/ai/git through /__broker.
    // Build: externalize the real SDK — the host serves it to the iframe at runtime.
    ...(serve
      ? {
          resolve: { alias: { '@owox/plugin-sdk': fileURLToPath(new URL('./ui/sdk-dev.ts', import.meta.url)) } },
          // Pin an uncommon port + strictPort so it never silently drifts to another
          // port (5173 clashed with the OWOX app → the 404 you saw). Fails loudly instead.
          server: { port: 5199, strictPort: true, fs: { allow: ['..'] } },
        }
      : {}),
    build: {
      outDir: '../dist/ui',
      emptyOutDir: true,
      rollupOptions: { external: ['@owox/plugin-sdk'] },
    },
  };
});
