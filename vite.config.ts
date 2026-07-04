import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'ui',
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    // The host serves @owox/plugin-sdk to the iframe at runtime as a bare import,
    // so externalize it — never bundle it, and the build never needs it on disk.
    rollupOptions: { external: ['@owox/plugin-sdk'] },
  },
});
