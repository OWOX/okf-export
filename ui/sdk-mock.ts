// Local mock of @owox/plugin-sdk. Two uses (AGENTS.md §10):
//  • `npm test`     — vitest aliases this file; tests override methods with vi.spyOn.
//  • `npm run dev`  — vite aliases this file (serve mode) so the UI runs in the browser with NO host.
//
// settings + storage are real (localStorage-backed) so you can iterate with LOCAL state; backend and
// the brokered capabilities need the real host, so here they're stubbed and logged to the console.
// For real credentials + a real export, install into the host (§10 Step 3).

// ── Local settings for browser dev ──────────────────────────────────────────
// Edit these, or from the browser console:
//   localStorage.setItem('owox.dev.settings', JSON.stringify({ 'example': 'value' }))
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

// Real key/value storage backed by localStorage so state survives reloads during dev.
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
  keys: async (prefix = ''): Promise<string[]> => {
    if (typeof localStorage === 'undefined') return [];
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('owox.dev.kv.')) {
        const bare = k.slice('owox.dev.kv.'.length);
        if (bare.startsWith(prefix)) out.push(bare);
      }
    }
    return out;
  },
};

// backend.call needs the sandboxed host runtime; stub it (returns an empty export result).
export const backend = {
  call: async (fn: string, args?: unknown): Promise<unknown> => {
    console.info('[owox dev mock] backend.call', fn, args);
    return { ok: true, count: 0, pushed: false };
  },
};

export const ui = { toast: (msg: string) => console.info('[owox dev mock] toast:', msg) };

// Brokered capabilities need the host. Stub every method to log + resolve, so the UI never crashes.
const stub = (name: string) =>
  new Proxy(
    {},
    {
      get: (_t, method) => async (...args: unknown[]) => {
        console.info(`[owox dev mock] ${name}.${String(method)}`, ...args);
        return undefined;
      },
    },
  ) as any;

export const owox = stub('owox');
export const ai = stub('ai');
export const git = stub('git');
export const sheets = stub('sheets');
export const credentials = stub('credentials');
