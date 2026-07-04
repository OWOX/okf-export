import { describe, it, expect, vi } from 'vitest';
import { slugify, parseRepo, extractColumns, renderMartDoc, renderIndex, exportMarts } from './backend';

describe('okf renderer', () => {
  it('slugify normalizes and falls back', () => {
    expect(slugify('My Mart! (v2)', 'fb')).toBe('my-mart-v2');
    expect(slugify('', 'fb')).toBe('fb');
  });

  it('parseRepo splits repo and subdir (dropping empty segments)', () => {
    expect(parseRepo('o/r')).toEqual({ repo: 'o/r', subdir: '' });
    expect(parseRepo('o/r/a/b')).toEqual({ repo: 'o/r', subdir: 'a/b' });
    expect(parseRepo('o/r/a/b/')).toEqual({ repo: 'o/r', subdir: 'a/b' });
  });

  it('extractColumns tolerates shapes', () => {
    expect(extractColumns({ fields: [{ name: 'x', type: 'STRING', description: 'd' }] })).toEqual([['x', 'STRING', 'd']]);
    expect(extractColumns({ columns: [{ alias: 'y', dataType: 'INT' }] })).toEqual([['y', 'INT', '']]);
    expect(extractColumns(null)).toEqual([]);
  });

  it('renderMartDoc emits valid frontmatter, overview, schema, and BigQuery source link', () => {
    const mart = {
      id: 'abc',
      title: 'Orders',
      description: 'All orders',
      definitionType: 'VIEW',
      status: 'ACTIVE',
      storage: { type: 'GOOGLE_BIGQUERY', title: 'BQ', config: { projectId: 'p' } },
      definition: { fullyQualifiedName: 'ds.orders' },
      schema: { fields: [{ name: 'total', type: 'FLOAT' }] },
      modifiedAt: '2026-01-01T00:00:00Z',
    };
    const md = renderMartDoc(mart, [{ total: 1 }], true, '2026-06-30T00:00:00Z');
    expect(md).toContain('type: "OWOX Data Mart"');
    expect(md).toContain('title: "Orders"');
    expect(md).toContain('timestamp: 2026-01-01T00:00:00Z'); // unquoted raw
    expect(md).toContain('resource: "https://console.cloud.google.com/bigquery?p=p&d=ds&t=orders&page=table"');
    expect(md).toContain('| `total` | FLOAT |');
    expect(md).toContain('## Sample (first 1 rows)');
  });

  it('renderMartDoc without source-link falls back to an opaque resource and no BigQuery URL', () => {
    const md = renderMartDoc({ id: 'x1', title: 'T', definitionType: 'SQL', storage: {} }, [], false, 'now');
    expect(md).toContain('resource: "owox-data-mart:x1"');
    expect(md).not.toContain('console.cloud.google.com');
    expect(md).not.toContain('## Schema');
    expect(md).not.toContain('## Sample');
  });

  it('renderIndex sorts marts and includes the AI overview', () => {
    const idx = renderIndex(
      [
        { id: '2', title: 'Zeta', slug: 'zeta', type: 'SQL', storage: 'BQ' },
        { id: '1', title: 'Alpha', slug: 'alpha', type: 'VIEW', storage: 'BQ' },
      ],
      'A tidy catalog.',
      '2026-06-30T00:00:00Z',
    );
    expect(idx).toContain('A tidy catalog.');
    expect(idx.indexOf('Alpha')).toBeLessThan(idx.indexOf('Zeta'));
  });
});

// --------------------------------------------------------------------------- //
// exportMarts — the brokered owox → ai → git orchestration, against a fake ctx.
// --------------------------------------------------------------------------- //
type CtxOpts = {
  settings?: Record<string, unknown>;
  pages?: any[]; // sequential responses to /api/data-marts?offset=...
  details?: Record<string, any>; // id → mart detail
  sample?: any[];
  aiThrows?: boolean;
};

function makeCtx(opts: CtxOpts = {}) {
  const settings = opts.settings ?? {};
  const pages = opts.pages ?? [{ items: [] }];
  const details = opts.details ?? {};
  const store: Record<string, any> = {};
  const puts: Array<{ repo: string; path: string; content: string }> = [];
  let pageIdx = 0;
  const ctx = {
    log: () => {},
    settings: { get: async (k: string) => settings[k] },
    owox: {
      request: async (_method: string, path: string) => {
        if (path.startsWith('/api/data-marts?')) return pages[pageIdx++] ?? { items: [] };
        const id = path.split('/').pop()!;
        return details[id] ?? { id, title: id };
      },
      dataMart: (_id: string) => ({ query: async () => opts.sample ?? [] }),
    },
    ai: {
      chat: vi.fn(async () => {
        if (opts.aiThrows) throw new Error('no ai grant');
        return { content: 'A tidy catalog overview.' };
      }),
    },
    storage: { set: async (k: string, v: unknown) => { store[k] = v; }, get: async (k: string) => store[k] },
    git: { repo: (repo: string) => ({ putFile: async (path: string, content: string) => { puts.push({ repo, path, content }); } }) },
  };
  return { ctx, store, puts };
}

describe('exportMarts', () => {
  it('paginates, applies the shared-only filter, renders docs, and persists to storage', async () => {
    const { ctx, store } = makeCtx({
      pages: [
        { items: [{ id: 'a', availableForReporting: true }, { id: 'b', availableForReporting: false }], nextOffset: 2 },
        { items: [{ id: 'c', availableForReporting: true }] }, // no nextOffset → stop
      ],
      details: {
        a: { id: 'a', title: 'Alpha', definitionType: 'VIEW', storage: { type: 'BQ' } },
        c: { id: 'c', title: 'Gamma', definitionType: 'SQL', storage: { type: 'BQ' } },
      },
    });

    const res = await exportMarts({}, ctx);

    expect(res.count).toBe(2); // 'b' filtered out by shared-only (default on)
    expect(res.pushed).toBeNull();
    expect(res.marts.map((m) => m.slug)).toEqual(['alpha', 'gamma']);
    expect(store['marts']).toHaveLength(2);
    expect(store['doc:alpha']).toContain('# Alpha');
    expect(store['doc:gamma']).toContain('# Gamma');
    expect(store['index']).toContain('A tidy catalog overview.');
    expect(store['summary']).toMatchObject({ count: 2, pushed: null });
  });

  it('includes non-reporting marts when shared-only is off', async () => {
    const { ctx } = makeCtx({
      settings: { 'shared-only': false },
      pages: [{ items: [{ id: 'a', availableForReporting: true }, { id: 'b', availableForReporting: false }] }],
      details: { a: { id: 'a', title: 'A' }, b: { id: 'b', title: 'B' } },
    });
    const res = await exportMarts({}, ctx);
    expect(res.count).toBe(2);
  });

  it('embeds a row sample only when sample-rows > 0', async () => {
    const { ctx, store } = makeCtx({
      settings: { 'sample-rows': 2 },
      pages: [{ items: [{ id: 'a', availableForReporting: true }] }],
      details: { a: { id: 'a', title: 'Alpha' } },
      sample: [{ x: 1 }, { x: 2 }, { x: 3 }],
    });
    await exportMarts({}, ctx);
    expect(store['doc:alpha']).toContain('## Sample (first 2 rows)');
    expect(store['doc:alpha']).toContain('{"x":1}');
    expect(store['doc:alpha']).not.toContain('{"x":3}'); // capped at 2
  });

  it('still renders (no overview) when the AI call fails', async () => {
    const { ctx, store } = makeCtx({
      aiThrows: true,
      pages: [{ items: [{ id: 'a', availableForReporting: true }] }],
      details: { a: { id: 'a', title: 'Alpha' } },
    });
    const res = await exportMarts({}, ctx);
    expect(res.count).toBe(1);
    expect(store['index']).toContain('# OWOX Data Marts');
    expect(store['index']).not.toContain('A tidy catalog overview.');
  });

  it('pushes each doc + index into the parsed repo/subdir when push is requested', async () => {
    const { ctx, puts } = makeCtx({
      settings: { 'github-repo': 'acme/catalog/okf' },
      pages: [{ items: [{ id: 'a', availableForReporting: true }] }],
      details: { a: { id: 'a', title: 'Alpha' } },
    });
    const res = await exportMarts({ push: true }, ctx);
    expect(res.pushed).toBe('acme/catalog/okf');
    expect(puts.every((p) => p.repo === 'acme/catalog')).toBe(true);
    expect(puts.map((p) => p.path)).toEqual(['okf/alpha.md', 'okf/index.md']);
  });

  it('refuses to push when github-repo is not set', async () => {
    const { ctx, puts } = makeCtx({
      pages: [{ items: [{ id: 'a', availableForReporting: true }] }],
      details: { a: { id: 'a', title: 'Alpha' } },
    });
    await expect(exportMarts({ push: true }, ctx)).rejects.toThrow(/github-repo/);
    expect(puts).toHaveLength(0);
  });
});
