import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { devBroker, type DevConfig } from './dev-broker';

// Two serve modes:
//   npm run dev         → @owox/plugin-sdk aliased to ui/sdk-mock.ts (localStorage, stubbed brokered
//                         calls). Fast UI iteration, no host, no creds. (AGENTS.md §10 Step 2.)
//   npm run dev:broker  → OWOX_DEV_BROKER=1. @owox/plugin-sdk aliased to ui/sdk-dev.ts, which runs the
//                         real backend.ts against a broker (dev-broker.ts) fed from owox.dev.json —
//                         real data marts, real export, no host. (§10 Step 3.)
// Build: externalize the real SDK — the host serves it to the iframe.
function readDevConfig(): DevConfig {
  // Read from the plugin root (cwd when running `npm run dev:broker`). NOT import.meta.url —
  // Vite bundles this config into node_modules/.vite-temp, so a relative URL misses the file.
  try {
    return JSON.parse(readFileSync(join(process.cwd(), 'owox.dev.json'), 'utf8'));
  } catch {
    return {}; // no owox.dev.json → broker falls back to canned data
  }
}

export default defineConfig(({ command }) => {
  const serve = command === 'serve';
  const useBroker = serve && !!process.env.OWOX_DEV_BROKER;
  const cfg = useBroker ? readDevConfig() : {};
  const sdk = useBroker ? './ui/sdk-dev.ts' : './ui/sdk-mock.ts';

  return {
    plugins: [react(), ...(useBroker ? [devBroker(cfg)] : [])],
    root: 'ui',
    ...(serve
      ? {
          resolve: { alias: { '@owox/plugin-sdk': fileURLToPath(new URL(sdk, import.meta.url)) } },
          // Broker mode: port from owox.dev.json (§10 Step 3 default 5177); import ../backend.ts from ui/.
          ...(useBroker ? { server: { port: cfg.ports?.ui ?? 5177, strictPort: true, fs: { allow: ['..'] } } } : {}),
        }
      : {}),
    build: {
      outDir: '../dist/ui',
      emptyOutDir: true,
      rollupOptions: { external: ['@owox/plugin-sdk'] },
    },
  };
});
