import { describe, it, expect } from 'vitest';
import {
  slugify, extractColumns, renderMartDoc, renderIndex, matchMart, distinctStorages, buildBundle, outboundCounts,
  type Filters,
} from './okf-core';
import { exportMarts } from './backend';

describe('okf-core render', () => {
  it('slugify normalizes and falls back', () => {
    expect(slugify('My Mart! (v2)', 'fb')).toBe('my-mart-v2');
    expect(slugify('', 'fb')).toBe('fb');
  });

  it('extractColumns tolerates shapes', () => {
    expect(extractColumns({ fields: [{ name: 'x', type: 'STRING', description: 'd' }] })).toEqual([['x', 'STRING', 'd']]);
    expect(extractColumns({ columns: [{ alias: 'y', dataType: 'INT' }] })).toEqual([['y', 'INT', '']]);
    expect(extractColumns(null)).toEqual([]);
  });

  it('renderMartDoc emits frontmatter, overview, schema, BigQuery source link', () => {
    const md = renderMartDoc({
      id: 'abc', title: 'Orders', description: 'All orders', definitionType: 'VIEW', status: 'ACTIVE',
      storage: { type: 'GOOGLE_BIGQUERY', title: 'BQ', config: { projectId: 'p' } },
      definition: { fullyQualifiedName: 'ds.orders' },
      schema: { fields: [{ name: 'total', type: 'FLOAT' }] },
      modifiedAt: '2026-01-01T00:00:00Z',
    }, '2026-06-30T00:00:00Z');
    expect(md).toContain('type: "OWOX Data Mart"');
    expect(md).toContain('timestamp: 2026-01-01T00:00:00Z');
    expect(md).toContain('resource: "https://console.cloud.google.com/bigquery?p=p&d=ds&t=orders&page=table"');
    expect(md).toContain('| `total` | FLOAT |');
  });

  it('renderIndex sorts marts into a table', () => {
    const idx = renderIndex(
      [{ id: '2', title: 'Zeta', slug: 'zeta', type: 'SQL', storage: 'BQ' }, { id: '1', title: 'Alpha', slug: 'alpha', type: 'VIEW', storage: 'BQ' }],
      '2026-06-30T00:00:00Z',
    );
    expect(idx.indexOf('Alpha')).toBeLessThan(idx.indexOf('Zeta'));
    expect(idx).toContain('| Data Mart | Type | Storage |');
  });
});

describe('okf-core filters', () => {
  const mart = (o: any) => ({ availableForReporting: false, availableForMaintenance: false, storage: { title: 'BQ' }, title: 'X', ...o });
  const f = (o: Partial<Filters> = {}): Filters => ({ reporting: true, maintenance: false, all: false, storages: ['BQ'], text: '', ...o });

  it('reporting filter matches availableForReporting', () => {
    expect(matchMart(mart({ availableForReporting: true }), f())).toBe(true);
    expect(matchMart(mart({ availableForReporting: false }), f())).toBe(false);
  });
  it('maintenance filter matches availableForMaintenance', () => {
    expect(matchMart(mart({ availableForMaintenance: true }), f({ reporting: false, maintenance: true }))).toBe(true);
  });
  it('all bypasses availability', () => {
    expect(matchMart(mart({}), f({ all: true, reporting: false }))).toBe(true);
  });
  it('storage must be in the selected set', () => {
    expect(matchMart(mart({ availableForReporting: true, storage: { title: 'Other' } }), f())).toBe(false);
  });
  it('text matches the title (case-insensitive)', () => {
    expect(matchMart(mart({ availableForReporting: true, title: 'Orders' }), f({ text: 'ORD' }))).toBe(true);
    expect(matchMart(mart({ availableForReporting: true, title: 'Orders' }), f({ text: 'zzz' }))).toBe(false);
  });
  it('distinctStorages dedupes + sorts by title', () => {
    expect(distinctStorages([{ storage: { title: 'B' } }, { storage: { title: 'A' } }, { storage: { title: 'B' } }])).toEqual(['A', 'B']);
  });
});

describe('buildBundle', () => {
  const owox = {
    request: async (_m: string, path: string) => {
      const id = path.split('/').pop();
      return { id, title: id === 'm1' ? 'Alpha' : 'Beta', definitionType: 'VIEW', storage: { type: 'BQ' } };
    },
  };
  it('renders index.md + one file per mart', async () => {
    const { files, metas } = await buildBundle(owox, [{ id: 'm1' }, { id: 'm2' }], '2026-06-30T00:00:00Z');
    expect(Object.keys(files).sort()).toEqual(['alpha.md', 'beta.md', 'index.md']);
    expect(files['alpha.md']).toContain('# Alpha');
    expect(metas.map((m) => m.slug)).toEqual(['alpha', 'beta']);
  });
});

describe('outboundCounts', () => {
  it('counts outbound relationships across all storages by source mart id', async () => {
    const owox = {
      request: async (_m: string, path: string) => {
        if (path === '/api/data-storages') return { items: [{ id: 's1' }, { id: 's2' }] };
        if (path === '/api/data-storages/s1/relationships') return [{ sourceDataMart: { id: 'a' } }, { sourceDataMart: { id: 'a' } }];
        if (path === '/api/data-storages/s2/relationships') return [{ sourceDataMart: { id: 'b' } }];
        return {};
      },
    };
    expect(await outboundCounts(owox)).toEqual({ a: 2, b: 1 });
  });
});

describe('backend.exportMarts (cron path)', () => {
  it('pushes reporting marts to the given repo/folder', async () => {
    const puts: string[] = [];
    const ctx = {
      log: () => {},
      owox: {
        request: async (_m: string, path: string) => {
          if (path.startsWith('/api/data-marts?')) return { items: [{ id: 'a', availableForReporting: true }, { id: 'b', availableForReporting: false }] };
          return { id: path.split('/').pop(), title: 'Alpha', definitionType: 'VIEW', storage: { type: 'BQ' } };
        },
      },
      git: { repo: () => ({ putFile: async (p: string) => { puts.push(p); } }) },
    };
    const res = await exportMarts({ repo: 'acme/cat', folder: 'okf' }, ctx);
    expect(res.count).toBe(1); // only the reporting mart
    expect(puts).toEqual(['okf/alpha.md', 'okf/index.md']);
  });
});
