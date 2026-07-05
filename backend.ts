// backend.ts — okf-export (v2). Named async fns; the host bundles + sandboxes this file.
// `ctx` is the capability surface minus `ui`, plus ctx.log and ctx.settings. There is no
// ambient fetch/fs/process/env — every privileged action goes through a brokered ctx.* call,
// so this plugin never holds an OWOX token, an AI key, or a GitHub token.

// --------------------------------------------------------------------------- //
// Pure OKF rendering helpers (exported for unit tests — see backend.test.ts)
// --------------------------------------------------------------------------- //
type Mart = Record<string, any>;
export type MartMeta = { id: string; title: string; slug: string; type: string; storage: string };

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
    if (project) {
      return { fqn, url: `https://console.cloud.google.com/bigquery?p=${project}&d=${dataset}&t=${table}&page=table` };
    }
  }
  return { fqn, url: null };
}

/** Render one data mart as an OKF concept document. */
export function renderMartDoc(mart: Mart, sampleRows: any[], sourceLink: boolean, now: string): string {
  const id = mart.id || '';
  const title = mart.title || id;
  const description = String(mart.description || '').trim();
  const defType = mart.definitionType || '';
  const status = mart.status || '';
  const storage = mart.storage || {};
  const storageType = storage.type || '';
  const storageTitle = storage.title || '';
  const { fqn, url } = sourceLink ? sourceUrl(mart) : { fqn: null, url: null };
  const resource = url || fqn || `owox-data-mart:${id}`;

  const tags = ['owox'];
  if (storageType) tags.push(String(storageType).toLowerCase());
  if (defType) tags.push(String(defType).toLowerCase());
  if (mart.connectorSourceName) tags.push(slugify(mart.connectorSourceName, 'connector'));

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
    `- **Storage:** ${storageTitle} (${storageType})`.replace(' ()', ''),
  );
  if (fqn) body.push(`- **Source:** \`${fqn}\``);
  body.push('');

  const cols = extractColumns(mart.schema);
  if (cols.length) {
    body.push('## Schema', '', '| Column | Type | Description |', '|--------|------|-------------|');
    for (const [n, t, d] of cols) body.push(`| \`${n}\` | ${t} | ${d.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
    body.push('');
  }
  if (sampleRows.length) {
    body.push(
      `## Sample (first ${sampleRows.length} rows)`, '',
      '> Preview only — the full dataset lives in OWOX.', '',
      '```json', sampleRows.map((r) => JSON.stringify(r)).join('\n'), '```', '',
    );
  }
  return fm + '\n\n' + body.join('\n').replace(/\s+$/, '') + '\n';
}

export function renderIndex(list: MartMeta[], overview: string, now: string): string {
  const fm = frontmatter({
    type: 'index', title: 'OWOX Data Marts',
    description: 'Index of exported OWOX data marts.', tags: ['owox', 'index'], timestamp: now,
  });
  const rows = [...list]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((m) => `| [${m.title.replace(/[[\]]/g, '\\$&')}](./${m.slug}.md) | ${m.type} | ${m.storage} |`);
  const body = ['# OWOX Data Marts', ''];
  if (overview) body.push(overview, '');
  body.push('| Data Mart | Type | Storage |', '|-----------|------|---------|', ...rows, '');
  return fm + '\n\n' + body.join('\n');
}

function overviewPrompt(list: MartMeta[]): string {
  const lines = list.map((m) => `- ${m.title} (${m.type || 'mart'}, ${m.storage || 'storage'})`).join('\n');
  return `Write a concise 2–3 sentence plain-English overview of this OWOX data-mart catalog for a ` +
    `README index. Do not use a heading or bullet points — just prose.\n\nData marts:\n${lines}`;
}

// --------------------------------------------------------------------------- //
// Brokered export chain: ctx.owox → ctx.ai → ctx.git (the plugin stores no secrets)
// --------------------------------------------------------------------------- //
async function listMarts(ctx: any): Promise<Mart[]> {
  const items: Mart[] = [];
  let offset = 0;
  for (let guard = 0; guard < 10000; guard++) {
    const page = await ctx.owox.request('GET', `/api/data-marts?offset=${offset}`);
    const batch = Array.isArray(page) ? page : page?.items ?? [];
    items.push(...batch);
    const next = Array.isArray(page) ? null : page?.nextOffset;
    if (!next) break;
    offset = next;
  }
  return items;
}

export async function exportMarts(input: { push?: boolean; repo?: string } = {}, ctx: any) {
  const now = new Date().toISOString();

  // data-mart is the one required grant. List marts available for reporting.
  ctx.log('listing data marts');
  const stubs = (await listMarts(ctx)).filter((m) => m.availableForReporting);

  const docs: Record<string, string> = {};
  const list: MartMeta[] = [];
  for (const stub of stubs) {
    const id = stub.id;
    ctx.log(`fetching ${id}`);
    const mart = await ctx.owox.request('GET', `/api/data-marts/${id}`);
    const title = mart.title || id;
    const slug = slugify(title, id);
    docs[slug] = renderMartDoc(mart, [], false, now);
    list.push({ id, title, slug, type: mart.definitionType || '', storage: mart.storage?.type || '' });
  }

  // Optional AI overview (ai-provider is an OPTIONAL grant). If it isn't granted
  // or the call fails, the index still renders without it.
  let overview = '';
  try {
    const reply = await ctx.ai.chat({ messages: [{ role: 'user', content: overviewPrompt(list) }] });
    overview = String(reply?.content ?? '').trim();
  } catch {
    /* ai-provider not granted — enrichment only */
  }
  const indexMd = renderIndex(list, overview, now);

  // Persist for the frontend. storage is host-owned, scoped to (project, plugin) — no grant.
  for (const [slug, md] of Object.entries(docs)) await ctx.storage.set(`doc:${slug}`, md);
  await ctx.storage.set('marts', list);
  await ctx.storage.set('index', indexMd);

  // Optional push (github is an OPTIONAL grant). The plugin supplies the target repo
  // (§6: ctx.git.repo(input.repo)); the broker injects the token — the plugin never
  // sees it. Throws GRANT_DENIED if the user skipped the github grant at install.
  let pushed = false;
  if (input.push) {
    if (!input.repo) throw new Error('A GitHub repo (owner/repo) is required to push.');
    const g = ctx.git.repo(input.repo);
    for (const [slug, md] of Object.entries(docs)) await g.putFile(`okf/${slug}.md`, md);
    await g.putFile('okf/index.md', indexMd);
    pushed = true;
  }

  const summary = { count: list.length, pushed, at: now };
  await ctx.storage.set('summary', summary);
  ctx.log(`exported ${list.length} mart(s)${pushed ? ' → pushed' : ''}`);
  return { ok: true, ...summary, marts: list };
}
