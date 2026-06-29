import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    lib: { entry: 'frontend/index.tsx', formats: ['es'], fileName: () => 'index.js' },
    outDir: 'dist/frontend',
    // Host provides react/react-dom via its /vendor import map — keep them
    // (and their JSX-runtime/client subpaths) external so the plugin uses the
    // host's single React instance. Bundling them causes "invalid hook call".
    rollupOptions: {
      external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
    },
  },
});
