import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  root: 'ui',
  // `npm run dev` (serve): resolve @owox/plugin-sdk to the local mock so the UI runs in the browser
  // with no host. `npm run build`: keep it external — the host serves the real SDK to the iframe.
  resolve:
    command === 'serve'
      ? { alias: { '@owox/plugin-sdk': fileURLToPath(new URL('./ui/sdk-mock.ts', import.meta.url)) } }
      : {},
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    rollupOptions: { external: ['@owox/plugin-sdk'] },
  },
}));
