// dev-broker.ts — DEV ONLY. A Vite plugin that emulates the OWOX capability broker for
// `npm run dev:broker`. It is fed entirely from the plugin's own `owox.dev.json` (AGENTS.md
// §10 Step 3 shape) — credentials are COPIED there once (gitignored); nothing is read from the
// host at run time. Exposes a same-origin POST /__broker; the browser/iframe never sees a secret.
// Not part of the production build.
import type { Plugin } from 'vite';

export type DevConfig = {
  owox?: { apiUrl?: string; apiKey?: string };
  credentials?: Array<{ type: string; secret?: string; config?: Record<string, unknown> }>;
  settings?: { global?: Record<string, unknown>; byProject?: Record<string, Record<string, unknown>> };
  ports?: { ui?: number; broker?: number };
};

function b64urlJson(s: string): any {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
}

function parseApiKey(key: string) {
  if (!key || !key.startsWith('owox_key_')) throw new Error("owox.apiKey must start with 'owox_key_'");
  const o = b64urlJson(key.slice('owox_key_'.length));
  return { apiOrigin: String(o.apiOrigin).replace(/\/$/, ''), apiKeyId: o.apiKeyId, apiKeySecret: o.apiKeySecret };
}

export function devBroker(cfg: DevConfig): Plugin {
  let auth: { origin: string; token: string; keyId: string } | null = null;
  const secretFor = (type: string) => cfg.credentials?.find((c) => c.type === type)?.secret || '';

  // The OWOX API key from owox.dev.json secures data-mart/storage/destination access, exchanged
  // for a short-lived token exactly like the host. No external secrets are touched at run time.
  async function owoxAuth() {
    if (auth) return auth;
    const key = cfg.owox?.apiKey;
    if (!key) throw Object.assign(new Error('no owox.apiKey in owox.dev.json — using canned data'), { code: 'NO_OWOX' });
    const { apiOrigin, apiKeyId, apiKeySecret } = parseApiKey(key);
    const res = await fetch(apiOrigin + '/api/auth/api-keys/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-OWOX-Api-Key-Id': apiKeyId },
      body: JSON.stringify({ apiKeySecret }),
    });
    if (!res.ok) throw new Error(`OWOX token exchange failed: HTTP ${res.status}`);
    const data: any = await res.json();
    if (!data.accessToken) throw new Error('OWOX token exchange returned no accessToken');
    auth = { origin: apiOrigin, token: data.accessToken, keyId: apiKeyId };
    console.log('[dev-broker] OWOX auth ok (from owox.dev.json) →', apiOrigin);
    return auth;
  }

  async function handle(capability: string, method: string, args: any[]): Promise<unknown> {
    if (capability === 'owox' && method === 'request') {
      const [m, path, body] = args as [string, string, unknown?];
      const hasBody = body != null; // guards GET/HEAD: a JSON-tunnelled `undefined` arrives as null
      const call = async () => {
        const a = await owoxAuth();
        return fetch(a.origin + path, {
          method: m,
          headers: {
            Authorization: `Bearer ${a.token}`,
            'x-owox-authorization': `Bearer ${a.token}`,
            'X-OWOX-Api-Key-Id': a.keyId,
            ...(hasBody ? { 'content-type': 'application/json' } : {}),
          },
          body: hasBody ? JSON.stringify(body) : undefined,
        });
      };
      let res = await call();
      if (res.status === 401) { auth = null; res = await call(); } // token expired → re-exchange once
      const text = await res.text();
      if (!res.ok) throw new Error(`OWOX ${m} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : null;
    }
    if (capability === 'credentials' && method === 'fetch') {
      // Escape hatch + grant check. args: [grant, path, init?]. No secret for the grant ⇒ GRANT_DENIED,
      // exactly as an ungranted credential behaves in prod.
      const [grant, path, init] = args as [string, string, RequestInit?];
      const secret = secretFor(grant);
      if (!secret) throw Object.assign(new Error(`no ${grant} secret in owox.dev.json`), { code: 'GRANT_DENIED' });
      if (grant !== 'github') throw Object.assign(new Error(`dev-broker: only github escape-hatch is wired`), { code: 'DEV_BROKER' });
      const res = await fetch(`https://api.github.com${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${secret}`, Accept: 'application/vnd.github+json', ...(init?.headers as any) },
      });
      return { status: res.status, body: await res.text() };
    }
    if (capability === 'ai') {
      // ai-provider is OPTIONAL. Stubbed unless owox.dev.json carries an ai-provider secret you wire up.
      return { content: '(dev-broker: AI stubbed — add an ai-provider secret in owox.dev.json to wire it)' };
    }
    if (capability === 'git' && method === 'putFile') {
      // github is OPTIONAL. Args match the real SDK: a single { repo, path, content }. Real push only
      // when owox.dev.json has a github secret (repo comes from the plugin); otherwise log.
      const { repo, path, content } = (args[0] ?? {}) as { repo?: string; path?: string; content?: string };
      const token = secretFor('github');
      const branch = 'main';
      if (!token || !repo || !path) {
        console.log('[dev-broker] git putFile (log only — add a github secret in owox.dev.json to push):', path);
        return { ok: true, logged: true };
      }
      const url = `https://api.github.com/repos/${repo}/contents/${path}`;
      const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
      const cur = await fetch(`${url}?ref=${branch}`, { headers: h });
      const sha = cur.ok ? (await cur.json()).sha : undefined;
      const put = await fetch(url, {
        method: 'PUT',
        headers: { ...h, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: `okf-export: ${path}`,
          content: Buffer.from(content ?? '', 'utf8').toString('base64'),
          branch,
          ...(sha ? { sha } : {}),
        }),
      });
      if (!put.ok) throw new Error(`GitHub PUT ${path} → HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`);
      console.log('[dev-broker] git pushed', `${repo}:${path}`);
      return { ok: true };
    }
    throw new Error(`dev-broker: unsupported ${capability}.${method}`);
  }

  return {
    name: 'owox-dev-broker',
    configureServer(server) {
      server.middlewares.use('/__broker', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', async () => {
          res.setHeader('content-type', 'application/json');
          try {
            const { capability, method, args } = JSON.parse(raw || '{}');
            const value = await handle(capability, method, args ?? []);
            res.end(JSON.stringify({ ok: true, value }));
          } catch (e: any) {
            res.end(JSON.stringify({ ok: false, error: { code: e.code || 'DEV_BROKER', message: e.message } }));
          }
        });
      });
    },
  };
}
