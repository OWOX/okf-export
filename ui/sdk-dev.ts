// Dev-only mock of @owox/plugin-sdk for STANDALONE debugging (`npm run dev`).
// It runs the REAL backend.ts against a `ctx` whose owox/ai/git go through the
// same-origin /__broker endpoint (the Vite dev broker). OWOX (data-mart) data is read
// via the host's configured project — no OWOX_API_KEY here; falls back to canned data
// if no host project is configured. github is optional (.env), ai is stubbed.
// This file never ships — Vite aliases '@owox/plugin-sdk' to it in serve mode only;
// the build externalizes the real SDK. See dev-broker.ts and vite.config.ts.
import * as backendFns from '../backend';

const store = new Map<string, unknown>(); // shared by frontend `storage` and backend `ctx.storage`

// Fallback data used only when the dev broker reports OWOX_API_KEY is missing.
const MARTS = [
  { id: 'm1', title: 'Orders', availableForReporting: true },
  { id: 'm2', title: 'Customers', availableForReporting: true },
];
const DETAILS: Record<string, any> = {
  m1: {
    id: 'm1', title: 'Orders', definitionType: 'VIEW', status: 'ACTIVE',
    storage: { type: 'GOOGLE_BIGQUERY', title: 'BigQuery' },
    schema: { fields: [{ name: 'order_id', type: 'STRING' }, { name: 'total', type: 'FLOAT' }] },
  },
  m2: {
    id: 'm2', title: 'Customers', definitionType: 'SQL', status: 'ACTIVE',
    storage: { type: 'GOOGLE_BIGQUERY', title: 'BigQuery' },
    schema: { fields: [{ name: 'customer_id', type: 'STRING' }] },
  },
};
function cannedOwox(path: string): unknown {
  if (path.startsWith('/api/data-marts?')) return { items: MARTS };
  return DETAILS[path.split('/').pop()!] ?? { id: 'x', title: 'x' };
}

async function broker(capability: string, method: string, args: unknown[]): Promise<any> {
  const res = await fetch('/__broker', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capability, method, args }),
  });
  const json = await res.json();
  if (json.ok) return json.value;
  throw Object.assign(new Error(json.error?.message || 'dev-broker error'), { code: json.error?.code });
}

const ctx = {
  log: (m: string) => console.log('[backend]', m),
  owox: {
    request: async (m: string, path: string, body?: unknown) => {
      try {
        return await broker('owox', 'request', [m, path, body]);
      } catch (e: any) {
        if (e.code === 'NO_OWOX') { console.warn('[dev] no OWOX project in host secrets → canned data'); return cannedOwox(path); }
        throw e;
      }
    },
  },
  ai: { chat: (payload: unknown) => broker('ai', 'chat', [payload]) },
  // Mirror the real SDK: putFile marshals a single { repo, path, content } object.
  git: { repo: (repo: string) => ({ putFile: (path: string, content: string) => broker('git', 'putFile', [{ repo, path, content }]) }) },
  storage: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, v); } },
};

export const storage = {
  get: async (k: string) => store.get(k),
  set: async (k: string, v: unknown) => { store.set(k, v); },
  delete: async (k: string) => { store.delete(k); },
  keys: async () => [...store.keys()],
};
export const backend = {
  call: async (fn: string, args?: unknown) => {
    const f = (backendFns as Record<string, any>)[fn];
    if (typeof f !== 'function') throw new Error(`dev sdk: no backend fn "${fn}"`);
    return f(args ?? {}, ctx);
  },
};
export const ui = { toast: (msg: string) => console.log('[toast]', msg) };
export const owox = ctx.owox as any;
export const ai = ctx.ai as any;
export const git = ctx.git as any;
export const settings = { get: async () => undefined, all: async () => ({}) } as any; // no settings; surface only
export const sheets = {} as any;
export const credentials = {} as any;
