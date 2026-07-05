import { describe, it, expect, vi } from 'vitest';
import { slugify, extractColumns, renderMartDoc, renderIndex, exportMarts } from './backend';

describe('okf renderer', () => {
  it('slugify normalizes and falls back', () => {
    expect(slugify('My Mart! (v2)', 'fb')).toBe('my-mart-v2');
    expect(slugify('', 'fb')).toBe('fb');
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
// exportMarts — brokered owox → ai → git orchestration, against a fake ctx.
// No settings: data-mart is required; ai + git are optional grants.
// --------------------------------------------------------------------------- //
type CtxOpts = { pages?: any[]; details?: Record<string, any>; aiThrows?: boolean };

function makeCtx(opts: CtxOpts = {}) {
  const pages = opts.pages ?? [{ items: [] }];
  const details = opts.details ?? {};
  const store: Record<string, any> = {};
  const puts: Array<{ repo: string; path: string; content: string }> = [];
  let pageIdx = 0;
  const ctx = {
    log: () => {},
    owox: {
      request: async (_method: string, path: string) => {
        if (path.startsWith('/api/data-marts?')) return pages[pageIdx++] ?? { items: [] };
        const id = path.split('/').pop()!;
        return details[id] ?? { id, title: id };
      },
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
  it('paginates, keeps only reporting marts, renders docs, and persists to storage', async () => {
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

    expect(res.count).toBe(2); // 'b' filtered out (not available for reporting)
    expect(res.pushed).toBe(false);
    expect(res.marts.map((m) => m.slug)).toEqual(['alpha', 'gamma']);
    expect(store['marts']).toHaveLength(2);
    expect(store['doc:alpha']).toContain('# Alpha');
    expect(store['index']).toContain('A tidy catalog overview.');
    expect(store['summary']).toMatchObject({ count: 2, pushed: false });
  });

  it('still renders (no overview) when the optional AI grant is missing', async () => {
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

  it('does not touch git unless push is requested', async () => {
    const { ctx, puts } = makeCtx({
      pages: [{ items: [{ id: 'a', availableForReporting: true }] }],
      details: { a: { id: 'a', title: 'Alpha' } },
    });
    await exportMarts({}, ctx);
    expect(puts).toHaveLength(0);
  });

  it('pushes each doc + index under okf/ to the supplied repo when push is requested', async () => {
    const { ctx, puts } = makeCtx({
      pages: [{ items: [{ id: 'a', availableForReporting: true }] }],
      details: { a: { id: 'a', title: 'Alpha' } },
    });
    const res = await exportMarts({ push: true, repo: 'acme/catalog' }, ctx);
    expect(res.pushed).toBe(true);
    expect(puts.map((p) => p.path)).toEqual(['okf/alpha.md', 'okf/index.md']);
    expect(puts.every((p) => p.repo === 'acme/catalog')).toBe(true);
  });

  it('refuses to push without a repo', async () => {
    const { ctx, puts } = makeCtx({
      pages: [{ items: [{ id: 'a', availableForReporting: true }] }],
      details: { a: { id: 'a', title: 'Alpha' } },
    });
    await expect(exportMarts({ push: true }, ctx)).rejects.toThrow(/repo/i);
    expect(puts).toHaveLength(0);
  });
});
