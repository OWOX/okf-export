// okf-core.ts — pure OKF rendering + data-mart fetch/filter helpers, capability-agnostic.
// Shared by the frontend wizard (ui/App.tsx, via the live SDK) and the cron backend
// (backend.ts, via ctx). No ambient fetch/fs — callers pass an `owox`/`git` surface.

type Mart = Record<string, any>;
export type MartMeta = { id: string; title: string; slug: string; type: string; storage: string };

/** owox capability surface used here (same shape on the frontend SDK and backend ctx). */
export type Owox = { request: (method: string, path: string, body?: unknown) => Promise<any> };

// --------------------------------------------------------------------------- //
// Filtering (step 1) — pure, unit-tested
// --------------------------------------------------------------------------- //
export type Filters = {
  reporting: boolean;   // availableForReporting
  maintenance: boolean; // availableForMaintenance
  all: boolean;         // ignore availability
  storages: string[];   // allowed storage titles (empty ⇒ none pass)
  text: string;         // case-insensitive substring of the title
};

export function storageTitle(m: Mart): string {
  return (m.storage?.title as string) || (m.storage?.type as string) || '';
}

export function distinctStorages(marts: Mart[]): string[] {
  return [...new Set(marts.map(storageTitle).filter(Boolean))].sort();
}

export function matchMart(m: Mart, f: Filters): boolean {
  const availOk = f.all || (f.reporting && !!m.availableForReporting) || (f.maintenance && !!m.availableForMaintenance);
  if (!availOk) return false;
  if (!f.storages.includes(storageTitle(m))) return false;
  if (f.text && !String(m.title || '').toLowerCase().includes(f.text.toLowerCase())) return false;
  return true;
}

// --------------------------------------------------------------------------- //
// Fetching
// --------------------------------------------------------------------------- //
export async function listMarts(owox: Owox): Promise<Mart[]> {
  const items: Mart[] = [];
  let offset = 0;
  for (let guard = 0; guard < 10000; guard++) {
    const page = await owox.request('GET', `/api/data-marts?offset=${offset}`);
    const batch = Array.isArray(page) ? page : page?.items ?? [];
    items.push(...batch);
    const next = Array.isArray(page) ? null : page?.nextOffset;
    if (!next) break;
    offset = next;
  }
  return items;
}

export const getMart = (owox: Owox, id: string): Promise<Mart> => owox.request('GET', `/api/data-marts/${id}`);

export async function listStorages(owox: Owox): Promise<Array<{ id: string; title: string; type?: string }>> {
  const r = await owox.request('GET', '/api/data-storages');
  return Array.isArray(r) ? r : r?.items ?? [];
}

export async function storageRelationships(owox: Owox, storageId: string): Promise<any[]> {
  const r = await owox.request('GET', `/api/data-storages/${storageId}/relationships`);
  return Array.isArray(r) ? r : r?.items ?? [];
}

/** Count OUTBOUND relationships per data mart (this mart is the relationship's source),
 * keyed by mart id. Relationships live per storage; we fetch every storage's relationships
 * once and tally by `sourceDataMart.id`. (We can't map marts→storage from the list — its
 * `storage.title` is context-decorated, not the real storage; only the detail has `storage.id`.
 * Counting by source id sidesteps that entirely.) */
export async function outboundCounts(owox: Owox): Promise<Record<string, number>> {
  const storages = await listStorages(owox);
  const counts: Record<string, number> = {};
  await Promise.all(
    storages.map(async (s) => {
      for (const r of await storageRelationships(owox, s.id)) {
        const src = r?.sourceDataMart?.id;
        if (src) counts[src] = (counts[src] || 0) + 1;
      }
    }),
  );
  return counts;
}

// --------------------------------------------------------------------------- //
// Rendering
// --------------------------------------------------------------------------- //
export function slugify(text: string, fallback: string): string {
  const s = (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || fallback;
}

function yamlScalar(v: unknown): string {
  const s = v == null ? '' : String(v);
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') + '"';
}

function frontmatter(fields: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [k, val] of Object.entries(fields)) {
    if (val == null) continue;
    if (Array.isArray(val)) lines.push(`${k}: [${val.map(yamlScalar).join(', ')}]`);
    else if (k === 'timestamp') lines.push(`${k}: ${val}`); // pre-formatted ISO, emitted unquoted
    else lines.push(`${k}: ${yamlScalar(val)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

export function extractColumns(schema: any): Array<[string, string, string]> {
  if (!schema || typeof schema !== 'object') return [];
  const fields = ['fields', 'columns', 'schema'].map((k) => schema[k]).find(Array.isArray);
  if (!fields) return [];
  return fields
    .filter((f: any) => f && typeof f === 'object')
    .map((f: any): [string, string, string] => [
      String(f.name ?? f.alias ?? f.field ?? ''),
      String(f.type ?? f.dataType ?? f.mode ?? ''),
      String(f.description ?? f.title ?? ''),
    ]);
}

function sourceUrl(mart: Mart): { fqn: string | null; url: string | null } {
  const storage = mart.storage || {};
  const def = mart.definition || {};
  const defType = mart.definitionType || '';
  let fqn: string | null = null;
  if (defType === 'VIEW') fqn = def.fullyQualifiedName || null;
  else if (defType === 'CONNECTOR') fqn = def.connector?.storage?.fullyQualifiedName || null;
  if (!fqn) return { fqn: null, url: null };
  if (storage.type === 'GOOGLE_BIGQUERY') {
    const parts = fqn.split('.');
    let project = '', dataset = '', table = '';
    if (parts.length === 3) [project, dataset, table] = parts;
    else if (parts.length === 2) { [dataset, table] = parts; project = storage.config?.projectId || ''; }
    else return { fqn, url: null };
    if (project) return { fqn, url: `https://console.cloud.google.com/bigquery?p=${project}&d=${dataset}&t=${table}&page=table` };
  }
  return { fqn, url: null };
}

export const martMeta = (m: Mart): MartMeta => ({
  id: m.id || '',
  title: m.title || m.id || '',
  slug: slugify(m.title || '', m.id || 'mart'),
  type: m.definitionType || '',
  storage: (m.storage?.type as string) || '',
});

/** Render one data mart as an OKF concept document. */
export function renderMartDoc(mart: Mart, now: string): string {
  const id = mart.id || '';
  const title = mart.title || id;
  const description = String(mart.description || '').trim();
  const defType = mart.definitionType || '';
  const status = mart.status || '';
  const storage = mart.storage || {};
  const { fqn, url } = sourceUrl(mart);
  const resource = url || fqn || `owox-data-mart:${id}`;

  const tags = ['owox'];
  if (storage.type) tags.push(String(storage.type).toLowerCase());
  if (defType) tags.push(String(defType).toLowerCase());

  let shortDesc = description ? description.split('\n')[0] : `OWOX data mart '${title}'.`;
  if (shortDesc.length > 200) shortDesc = shortDesc.slice(0, 197) + '...';

  const fm = frontmatter({
    type: 'OWOX Data Mart', title, description: shortDesc,
    resource, tags, timestamp: mart.modifiedAt || now,
  });

  const body: string[] = [`# ${title}`, ''];
  if (description) body.push(description, '');
  body.push(
    '## Overview', '',
    `- **ID:** \`${id}\``,
    `- **Status:** ${status}`,
    `- **Definition type:** ${defType}`,
    `- **Storage:** ${storage.title || ''} (${storage.type || ''})`.replace(' ()', ''),
  );
  if (fqn) body.push(`- **Source:** \`${fqn}\``);
  body.push('');

  const cols = extractColumns(mart.schema);
  if (cols.length) {
    body.push('## Schema', '', '| Column | Type | Description |', '|--------|------|-------------|');
    for (const [n, t, d] of cols) body.push(`| \`${n}\` | ${t} | ${d.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
    body.push('');
  }
  return fm + '\n\n' + body.join('\n').replace(/\s+$/, '') + '\n';
}

export function renderIndex(list: MartMeta[], now: string): string {
  const fm = frontmatter({
    type: 'index', title: 'OWOX Data Marts',
    description: 'Index of exported OWOX data marts.', tags: ['owox', 'index'], timestamp: now,
  });
  const rows = [...list]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((m) => `| [${m.title.replace(/[[\]]/g, '\\$&')}](./${m.slug}.md) | ${m.type} | ${m.storage} |`);
  const body = ['# OWOX Data Marts', '', '| Data Mart | Type | Storage |', '|-----------|------|---------|', ...rows, ''];
  return fm + '\n\n' + body.join('\n');
}

/** Fetch each mart's detail and render the full OKF bundle as a { filename: content } map. */
export async function buildBundle(owox: Owox, stubs: Mart[], now: string): Promise<{ files: Record<string, string>; metas: MartMeta[] }> {
  const files: Record<string, string> = {};
  const metas: MartMeta[] = [];
  for (const stub of stubs) {
    const mart = await getMart(owox, stub.id);
    const meta = martMeta(mart);
    metas.push(meta);
    files[`${meta.slug}.md`] = renderMartDoc(mart, now);
  }
  files['index.md'] = renderIndex(metas, now);
  return { files, metas };
}
