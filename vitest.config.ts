import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
    // Resolve the externalized SDK import to the local mock during tests.
    alias: { '@owox/plugin-sdk': new URL('./ui/sdk-mock.ts', import.meta.url).pathname },
  },
});
