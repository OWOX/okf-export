// dev-broker.ts — DEV ONLY. A Vite plugin that emulates the OWOX capability broker
// for standalone debugging. It sources the OWOX (data-mart) credential the SAME way
// the real host does — from the host's configured project, NOT from the plugin — so
// there is no OWOX_API_KEY to manage here. It exposes a same-origin POST /__broker;
// the browser/iframe never sees a secret. Not part of the production build.
import type { Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

function b64urlJson(s: string): any {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
}

function parseApiKey(key: string) {
  if (!key || !key.startsWith('owox_key_')) throw new Error("host owox key must start with 'owox_key_'");
  const o = b64urlJson(key.slice('owox_key_'.length));
  return { apiOrigin: String(o.apiOrigin).replace(/\/$/, ''), apiKeyId: o.apiKeyId, apiKeySecret: o.apiKeySecret };
}

/** Read the active project's OWOX key from the host's own secrets/ (same source the
 *  real broker uses). Returns null if the host isn't configured → canned fallback. */
function owoxKeyFromHost(hostDir: string): string | null {
  try {
    const projects = JSON.parse(readFileSync(join(hostDir, 'secrets/projects.json'), 'utf8'));
    const secrets = JSON.parse(readFileSync(join(hostDir, 'secrets/secrets.json'), 'utf8'));
    return secrets[projects.activeId] ?? null;
  } catch {
    return null;
  }
}

export function devBroker(env: Record<string, string>): Plugin {
  // Sibling checkout by default; override with OWOX_HOST_DIR in .env if elsewhere.
  const hostDir = resolve(process.cwd(), env.OWOX_HOST_DIR || '../owox-data-marts-experimental');
  let auth: { origin: string; token: string; keyId: string } | null = null;

  async function owoxAuth() {
    if (auth) return auth;
    const key = owoxKeyFromHost(hostDir);
    if (!key) {
      throw Object.assign(new Error(`no OWOX project configured in ${hostDir}/secrets — using canned data`), { code: 'NO_OWOX' });
    }
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
    console.log('[dev-broker] OWOX auth ok (from host project) →', apiOrigin);
    return auth;
  }

  async function handle(capability: string, method: string, args: any[]): Promise<unknown> {
    if (capability === 'owox' && method === 'request') {
      const a = await owoxAuth();
      const [m, path, body] = args as [string, string, unknown?];
      const res = await fetch(a.origin + path, {
        method: m,
        headers: {
          Authorization: `Bearer ${a.token}`,
          'x-owox-authorization': `Bearer ${a.token}`,
          'X-OWOX-Api-Key-Id': a.keyId,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`OWOX ${m} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : null;
    }
    if (capability === 'ai') {
      // ai-provider is OPTIONAL. Stubbed by default so the chain runs without a key.
      return { content: '(dev-broker: AI stubbed — wire a provider in dev-broker.ts to test real output)' };
    }
    if (capability === 'git' && method === 'putFile') {
      // github is OPTIONAL. Args match the real SDK: a single { repo, path, content }.
      // Real push only when GITHUB_TOKEN is set (repo comes from the plugin, like prod);
      // otherwise log so debugging never pushes by accident.
      const { repo: argRepo, path, content } = (args[0] ?? {}) as { repo?: string; path?: string; content?: string };
      const { GITHUB_TOKEN: token, GITHUB_BRANCH: branch = 'main' } = env;
      const repo = argRepo || env.GITHUB_REPO;
      if (!token || !repo || !path) {
        console.log('[dev-broker] git putFile (log only — set GITHUB_TOKEN for real push):', path);
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
