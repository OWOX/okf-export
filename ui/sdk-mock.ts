// Local mock of @owox/plugin-sdk (AGENTS.md §10). Two uses:
//  • `npm test`     — vitest aliases this file; tests override methods with vi.spyOn.
//  • `npm run dev`  — vite aliases this file (serve mode) so the UI runs in the browser with NO host.
//
// settings + storage are real (localStorage). owox/git/credentials return small CANNED responses so
// the wizard is fully clickable offline; for real data marts + real export use `npm run dev:broker`.

const DEV_DEFAULTS: Record<string, unknown> = {};

function devSettings(): Record<string, unknown> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('owox.dev.settings') : null;
    return { ...DEV_DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEV_DEFAULTS };
  }
}

export const settings = {
  get: async (key: string): Promise<unknown> => devSettings()[key],
  all: async (): Promise<Record<string, unknown>> => devSettings(),
};

export const storage = {
  get: async (key: string): Promise<unknown> => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('owox.dev.kv.' + key) : null;
    return v == null ? undefined : JSON.parse(v);
  },
  set: async (key: string, value: unknown): Promise<void> => {
    if (typeof localStorage !== 'undefined') localStorage.setItem('owox.dev.kv.' + key, JSON.stringify(value));
  },
  delete: async (key: string): Promise<void> => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem('owox.dev.kv.' + key);
  },
};

// ── Canned data marts so the wizard is usable with no host ───────────────────
const DEMO_MARTS: any[] = [
  {
    id: 'm1', title: 'Orders', definitionType: 'VIEW', status: 'PUBLISHED',
    availableForReporting: true, availableForMaintenance: false,
    storage: { type: 'GOOGLE_BIGQUERY', title: 'BigQuery [Common]' },
    schema: { fields: [{ name: 'order_id', type: 'STRING' }, { name: 'total', type: 'FLOAT' }] },
  },
  {
    id: 'm2', title: 'Ops Log', definitionType: 'SQL', status: 'DRAFT',
    availableForReporting: false, availableForMaintenance: true,
    storage: { type: 'SNOWFLAKE', title: 'Snowflake [Marketing]' },
    schema: { fields: [{ name: 'ts', type: 'TIMESTAMP' }] },
  },
];

const DEMO_STORAGES = [
  { id: 's-bq', title: 'BigQuery [Common]', type: 'GOOGLE_BIGQUERY' },
  { id: 's-sf', title: 'Snowflake [Marketing]', type: 'SNOWFLAKE' },
];
const DEMO_RELATIONSHIPS: Record<string, any[]> = {
  's-bq': [{ id: 'r1', sourceDataMart: { id: 'm1', title: 'Orders' }, targetDataMart: { id: 'm2', title: 'Ops Log' } }],
  's-sf': [],
};

export const owox = {
  request: async (_method: string, path: string): Promise<unknown> => {
    if (path.startsWith('/api/data-marts?')) return { items: DEMO_MARTS };
    if (path === '/api/data-storages') return { items: DEMO_STORAGES };
    const relMatch = path.match(/^\/api\/data-storages\/([^/]+)\/relationships$/);
    if (relMatch) return DEMO_RELATIONSHIPS[relMatch[1]] ?? [];
    const id = path.split('/').pop();
    return DEMO_MARTS.find((m) => m.id === id) ?? { id, title: id };
  },
  dataMart: (id: string) => ({ query: async () => { console.info('[owox dev mock] dataMart.query', id); return []; } }),
};

export const git = {
  repo: (name: string) => ({
    putFile: async (path: string, _content: string) => { console.info('[owox dev mock] git.putFile', name, path); return { ok: true }; },
    getFile: async (path: string) => { console.info('[owox dev mock] git.getFile', name, path); return undefined; },
    openPR: async (opts: unknown) => { console.info('[owox dev mock] git.openPR', name, opts); return { ok: true }; },
  }),
};

// credentials.<grant>.fetch — mock the GitHub REST calls the PR flow makes (grant assumed present).
export const credentials = new Proxy({} as any, {
  get: (_t, grant: string) => ({
    fetch: async (path: string, init?: any) => {
      const method = init?.method || 'GET';
      console.info('[owox dev mock] credentials.' + grant + '.fetch', method, path);
      if (grant !== 'github') return { status: 200, body: '' };
      if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return { status: 200, body: JSON.stringify({ permissions: { push: true }, default_branch: 'main' }) };
      if (path.includes('/git/ref/heads/')) return { status: 200, body: JSON.stringify({ object: { sha: 'base-sha' } }) };
      if (path.includes('/git/refs') && method === 'POST') return { status: 201, body: JSON.stringify({ ref: 'refs/heads/okf-export' }) };
      if (path.includes('/contents/') && method === 'GET') return { status: 404, body: '{}' }; // new branch → file absent
      if (path.includes('/contents/') && method === 'PUT') return { status: 201, body: '{}' };
      if (path.includes('/pulls') && method === 'POST') return { status: 201, body: JSON.stringify({ html_url: 'https://github.com/acme/catalog/pull/1' }) };
      return { status: 200, body: '{}' }; // e.g. /user grant check
    },
  }),
});

export const backend = {
  call: async (fn: string, args?: unknown): Promise<unknown> => {
    console.info('[owox dev mock] backend.call', fn, args);
    return { ok: true };
  },
};

export const ui = { toast: (msg: string) => console.info('[owox dev mock] toast:', msg) };

const stub = (name: string) =>
  new Proxy({}, { get: (_t, method) => async (...args: unknown[]) => { console.info(`[owox dev mock] ${name}.${String(method)}`, ...args); return undefined; } }) as any;

export const ai = stub('ai');
export const sheets = stub('sheets');
