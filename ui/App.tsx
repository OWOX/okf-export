import { useEffect, useMemo, useRef, useState } from 'react';
import { owox, credentials, ui } from '@owox/plugin-sdk';
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, Download, Filter, Github, Loader2, Search, X } from 'lucide-react';
import { buildBundle, distinctStorages, getMart, listMarts, martMeta, matchMart, outboundCounts, renderMartDoc, type Filters } from '../okf-core';
import { downloadZip } from './okf-download';

type Step = 1 | 2;
const STEPS = ['Data marts', 'Export'] as const;

/** owner/repo + optional folder path from a URL (…/tree/<branch>/<path> or …/<path>). */
function parseGithubUrl(url: string): { repo: string; folder: string } {
  const s = url.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
  const parts = s.split('/').filter(Boolean);
  const repo = parts.slice(0, 2).join('/');
  let rest = parts.slice(2);
  if (rest[0] === 'tree' || rest[0] === 'blob') rest = rest.slice(2); // drop /tree/<branch>
  return { repo, folder: rest.join('/') };
}

// UTF-8 → base64 (btoa is latin1-only; OKF docs contain emoji/unicode).
function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

const inputCls =
  'border-input focus-visible:ring-ring h-9 rounded-md border bg-white px-3 text-sm text-neutral-900 shadow-xs placeholder:text-neutral-400 focus-visible:ring-[3px] focus-visible:outline-none';
const btnPrimary =
  'inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary-hover focus-visible:ring-ring focus-visible:ring-[3px] focus-visible:outline-none disabled:opacity-50';
const btnOutline =
  'inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent focus-visible:ring-ring focus-visible:ring-[3px] focus-visible:outline-none disabled:opacity-50';
// Match the app's Data Marts table (shadcn Table primitives).
const thCls = 'text-foreground h-10 px-2 text-left align-middle font-medium whitespace-nowrap';
const tdCls = 'p-2 align-middle whitespace-nowrap';

export function App() {
  const [step, setStep] = useState<Step>(1);
  const [marts, setMarts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Filters (real-time)
  const [reporting, setReporting] = useState(true);
  const [maintenance, setMaintenance] = useState(false);
  const [all, setAll] = useState(false);
  const [storages, setStorages] = useState<string[]>([]);
  const [text, setText] = useState('');

  // Selection + relationships + detail panel
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rels, setRels] = useState<Record<string, number> | null>(null);
  const [relsErr, setRelsErr] = useState(false);
  const [detail, setDetail] = useState<{ title: string; doc: string } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);

  // Export
  const [dest, setDest] = useState<'github' | 'file' | null>(null);
  const [githubUrl, setGithubUrl] = useState('');
  const [ghGranted, setGhGranted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    listMarts(owox)
      .then((m) => { setMarts(m); setStorages(distinctStorages(m)); })
      .catch((e) => setLoadError((e as Error).message))
      .finally(() => setLoading(false));
    // Outbound relationship counts (per storage). Needs the Storage permission; degrade to “—”.
    outboundCounts(owox).then(setRels).catch(() => { setRelsErr(true); setRels({}); });
  }, []);

  const allStorages = useMemo(() => distinctStorages(marts), [marts]);
  const filters: Filters = { reporting, maintenance, all, storages, text };
  const matched = useMemo(() => marts.filter((m) => matchMart(m, filters)), [marts, reporting, maintenance, all, storages, text]);
  const selectedMarts = useMemo(() => matched.filter((m) => selected.has(m.id)), [matched, selected]);

  useEffect(() => { setSelected(new Set(matched.map((m) => m.id))); }, [matched]);
  useEffect(() => {
    const el = selectAllRef.current;
    if (!el) return;
    const every = matched.length > 0 && matched.every((m) => selected.has(m.id));
    el.indeterminate = matched.some((m) => selected.has(m.id)) && !every;
  }, [matched, selected]);

  function toggleStorage(s: string, on: boolean) {
    setStorages((cur) => (on ? [...new Set([...cur, s])] : cur.filter((x) => x !== s)));
  }
  function toggleMart(id: string, on: boolean) {
    setSelected((cur) => { const n = new Set(cur); on ? n.add(id) : n.delete(id); return n; });
  }
  function goStep(n: Step) { if (n < step) { setStep(n); setError(''); setDone(''); } }

  async function openDetail(m: any) {
    setDetailLoading(true);
    setDetail({ title: m.title, doc: '' });
    try {
      const full = await getMart(owox, m.id);
      setDetail({ title: full.title || m.title, doc: renderMartDoc(full, new Date().toISOString()) });
    } catch (e) {
      setDetail({ title: m.title, doc: `Could not load: ${(e as Error).message}` });
    } finally {
      setDetailLoading(false);
    }
  }

  async function pickGithub() {
    setDest('github');
    setGhGranted(null);
    try {
      await (credentials as any).github.fetch('/user');
      setGhGranted(true);
    } catch (e) {
      const code = (e as any)?.code;
      setGhGranted(!(code === 'GRANT_DENIED' || code === 'NO_CREDENTIAL'));
    }
  }

  // Brokered GitHub REST call via the escape hatch (token injected by the host).
  async function gh(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const init: any = { method };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'content-type': 'application/json' }; }
    const res: any = await (credentials as any).github.fetch(path, init);
    const b = res?.body;
    let json: any;
    if (typeof b === 'string') { try { json = b ? JSON.parse(b) : undefined; } catch { json = undefined; } }
    else json = b ?? res?.json;
    return { status: res?.status ?? 0, json };
  }

  async function runFile() {
    setBusy(true); setError(''); setDone('');
    try {
      setProgress('Fetching data marts…');
      const { files, metas } = await buildBundle(owox, selectedMarts.map(martMeta), new Date().toISOString());
      downloadZip('okf-bundle.zip', files);
      setDone(`Downloaded okf-bundle.zip — ${metas.length} data mart(s).`);
      ui.toast('Bundle downloaded ✓');
    } catch (e) {
      setError((e as Error).message); ui.toast('Export failed');
    } finally {
      setBusy(false); setProgress('');
    }
  }

  // Export to GitHub = open a pull request: check write access → branch → commit → PR.
  async function runGithub() {
    setBusy(true); setError(''); setDone('');
    try {
      const { repo, folder } = parseGithubUrl(githubUrl);
      if (!repo.includes('/')) throw new Error('Enter a GitHub repo URL, e.g. https://github.com/owner/repo');

      setProgress('Checking write access…');
      const info = await gh('GET', `/repos/${repo}`);
      if (info.status === 404) throw new Error(`Repository ${repo} not found or not accessible with the granted token.`);
      if (info.status >= 300) throw new Error(`GitHub error ${info.status}: ${info.json?.message || 'repo check failed'}`);
      if (!info.json?.permissions?.push) throw new Error(`No write access to ${repo} — the granted GitHub credential needs push permission.`);
      const base = info.json.default_branch || 'main';

      setProgress('Fetching data marts…');
      const { files, metas } = await buildBundle(owox, selectedMarts.map(martMeta), new Date().toISOString());
      const prefix = folder ? folder.replace(/^\/+|\/+$/g, '') + '/' : '';

      setProgress('Creating branch…');
      const ref = await gh('GET', `/repos/${repo}/git/ref/heads/${base}`);
      const baseSha = ref.json?.object?.sha;
      if (!baseSha) throw new Error(`Could not read the base branch "${base}".`);
      const branch = `okf-export-${Date.now()}`;
      const mk = await gh('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
      if (mk.status >= 300) throw new Error(`Could not create branch: ${mk.json?.message || mk.status}`);

      const names = Object.keys(files);
      let i = 0;
      for (const name of names) {
        const p = `${prefix}${name}`; // nested paths auto-create folders in the contents API
        setProgress(`Committing ${++i}/${names.length}: ${p}`);
        const enc = p.split('/').map(encodeURIComponent).join('/');
        const cur = await gh('GET', `/repos/${repo}/contents/${enc}?ref=${branch}`);
        const sha = cur.status === 200 ? cur.json?.sha : undefined;
        const put = await gh('PUT', `/repos/${repo}/contents/${enc}`, { message: `okf-export: ${p}`, content: toBase64(files[name]), branch, ...(sha ? { sha } : {}) });
        if (put.status >= 300) throw new Error(`Could not commit ${p}: ${put.json?.message || put.status}`);
      }

      setProgress('Opening pull request…');
      const pr = await gh('POST', `/repos/${repo}/pulls`, {
        title: `OKF export — ${metas.length} data mart(s)`,
        head: branch, base,
        body: 'Automated OKF bundle export from the OWOX okf-export plugin.',
      });
      if (pr.status >= 300) throw new Error(`Could not open pull request: ${pr.json?.message || pr.status}`);
      setDone(`Opened pull request → ${pr.json.html_url}`);
      ui.toast('Pull request opened ✓');
    } catch (e) {
      setError((e as Error).message); ui.toast('Export failed');
    } finally {
      setBusy(false); setProgress('');
    }
  }

  const allChecked = matched.length > 0 && matched.every((m) => selected.has(m.id));

  return (
    <div className="dm-page bg-background text-foreground">
      <header className="dm-page-header">
        <h1 className="dm-page-header-title">OKF Export</h1>
        <ol className="mt-3 flex flex-wrap gap-2 text-sm" data-testid="stepper">
          {STEPS.map((label, i) => {
            const n = (i + 1) as Step;
            const active = n === step;
            const passed = n < step;
            return (
              <li key={label}>
                <button
                  type="button"
                  disabled={!passed}
                  onClick={() => goStep(n)}
                  data-testid={`step-${n}`}
                  className={'flex items-center gap-2 rounded-md border px-3 py-1 ' + (active ? 'bg-primary text-primary-foreground border-transparent' : passed ? 'hover:bg-accent cursor-pointer' : 'text-muted-foreground cursor-default')}
                >
                  <span className="font-medium">{n}</span> {label}
                </button>
              </li>
            );
          })}
        </ol>
      </header>

      <div className="dm-page-content flex flex-col gap-4 pb-12">
        {loadError && <Banner kind="error" text={`Could not load data marts: ${loadError}`} />}
        {loading ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Loading data marts…</div>
        ) : step === 1 ? (
          <div className="flex flex-col gap-4" data-testid="step-marts">
            {/* Data marts list — toolbar (Filters ▾ + Search) + table in one card, like the Data Marts page */}
            <div className="flex items-start gap-4">
              {/* No overflow-hidden here — it would clip the Filters dropdown. The table wrapper
                  below has its own overflow-x-auto (which doesn't contain the dropdown). */}
              <div className="dm-card min-w-0 flex-1 p-0">
                <div className="flex items-center gap-2 border-b p-3">
                  <FiltersMenu>
                    <Field label="Availability">
                      <div className="flex flex-col gap-1.5">
                        <Check label="Shared for reporting" checked={all || reporting} disabled={all} onChange={setReporting} />
                        <Check label="Shared for maintenance" checked={all || maintenance} disabled={all} onChange={setMaintenance} />
                        <Check label="All" checked={all} onChange={setAll} />
                      </div>
                    </Field>
                    {allStorages.length > 0 && (
                      <div className="mt-3">
                        <Field label="Storages">
                          <div className="flex flex-col gap-1.5">
                            {allStorages.map((s) => (
                              <Check key={s} label={s} checked={storages.includes(s)} onChange={(on) => toggleStorage(s, on)} />
                            ))}
                          </div>
                        </Field>
                      </div>
                    )}
                  </FiltersMenu>
                  <div className="relative max-w-md min-w-0 flex-1">
                    <Search className="text-muted-foreground absolute top-2.5 left-2 h-4 w-4" />
                    <input className="border-input focus-visible:ring-ring h-9 w-full rounded-md border bg-white pl-8 text-sm text-neutral-900 shadow-xs placeholder:text-neutral-400 focus-visible:ring-[3px] focus-visible:outline-none" value={text} placeholder="Search" onChange={(e) => setText(e.target.value)} data-testid="filter-text" />
                  </div>
                </div>
                {matched.length === 0 ? (
                  <div className="text-muted-foreground p-4 text-sm">No data marts match the current filters.</div>
                ) : (
                  <div className="relative w-full overflow-x-auto">
                    <table className="w-full caption-bottom text-sm">
                      <thead className="[&_tr]:border-b">
                        <tr>
                          <th className={`${thCls} w-8`}>
                            <input ref={selectAllRef} type="checkbox" className="accent-primary size-4" checked={allChecked} onChange={(e) => setSelected(e.target.checked ? new Set(matched.map((m) => m.id)) : new Set())} aria-label="Select all" data-testid="select-all" />
                          </th>
                          <th className={thCls}>Title</th>
                          <th className={thCls}>Input Source</th>
                          <th className={thCls}>Storage</th>
                          <th className={thCls}>Relationships</th>
                        </tr>
                      </thead>
                      <tbody className="[&_tr:last-child]:border-0">
                        {matched.map((m) => (
                          <tr key={m.id} data-state={selected.has(m.id) ? 'selected' : undefined} onClick={() => openDetail(m)} className="hover:bg-muted/50 data-[state=selected]:bg-muted cursor-pointer border-b transition-colors" data-testid="mart-row">
                            <td className={tdCls} onClick={(e) => e.stopPropagation()}>
                              <input type="checkbox" className="accent-primary size-4" checked={selected.has(m.id)} onChange={(e) => toggleMart(m.id, e.target.checked)} aria-label={`Select ${m.title}`} />
                            </td>
                            <td className={tdCls}>{m.title}</td>
                            <td className={tdCls}>{m.definitionType}</td>
                            <td className={tdCls}>{m.storage?.title || m.storage?.type || ''}</td>
                            <td className={tdCls}>{relsErr ? '—' : rels ? (rels[m.id] ?? 0) : '…'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {detail && (
                <div className="dm-card w-96 shrink-0" data-testid="detail-panel">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h2 className="text-base font-semibold">{detail.title}</h2>
                    <button className="hover:bg-accent rounded-md p-1" onClick={() => setDetail(null)} aria-label="Close"><X className="h-4 w-4" /></button>
                  </div>
                  {detailLoading ? (
                    <div className="text-muted-foreground flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
                  ) : (
                    <pre className="bg-card text-card-foreground max-h-[60vh] overflow-auto rounded-md border p-3 text-xs leading-relaxed">{detail.doc}</pre>
                  )}
                </div>
              )}
            </div>

            {relsErr && <p className="text-muted-foreground text-xs">Relationship counts are unavailable — the Storage permission (and host access to <code>/api/data-storages</code>) is required.</p>}

            <div className="flex items-center gap-3">
              <button className={btnPrimary} onClick={() => setStep(2)} disabled={selected.size === 0} data-testid="to-step-2">
                Next <ArrowRight className="h-4 w-4" />
              </button>
              <span className="text-muted-foreground text-sm" data-testid="selected-count">{selected.size} of {matched.length} selected</span>
            </div>
          </div>
        ) : (
          /* ── Step 2: destination ─────────────────────────────────────── */
          <div className="flex flex-col gap-4" data-testid="step-export">
            <div className="grid gap-3 sm:grid-cols-2">
              <DestCard icon={<Github className="h-5 w-5" />} title="Export to GitHub" desc="Commit the OKF bundle to a repository." selected={dest === 'github'} onClick={pickGithub} testid="dest-github" />
              <DestCard icon={<Download className="h-5 w-5" />} title="Save to file" desc="Download the OKF bundle as a .zip." selected={dest === 'file'} onClick={() => setDest('file')} testid="dest-file" />
            </div>

            {dest === 'github' && (
              <div className="dm-card flex flex-col gap-4">
                {ghGranted === false ? (
                  <Banner kind="error" text="No GitHub credential is granted. Remove and reinstall the plugin, then grant GitHub on the consent screen (it's an optional permission)." />
                ) : ghGranted === null ? (
                  <div className="text-muted-foreground flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Checking GitHub access…</div>
                ) : (
                  <Banner kind="ok" text="GitHub credential granted." />
                )}
                <Field label="GitHub repository URL">
                  <input className={`${inputCls} w-full max-w-lg`} value={githubUrl} placeholder="https://github.com/owner/repo (or …/tree/main/folder)" onChange={(e) => setGithubUrl(e.target.value)} data-testid="github-url" />
                </Field>
                <p className="text-muted-foreground text-xs">Opens a pull request against the default branch. Add a folder to the URL path to target it — it's created if missing.</p>
                <div className="flex items-center gap-3">
                  <button className={btnOutline} onClick={() => setStep(1)}><ArrowLeft className="h-4 w-4" /> Back</button>
                  <button className={btnPrimary} onClick={runGithub} disabled={busy || ghGranted !== true || !githubUrl.trim()} data-testid="run-github">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Github className="h-4 w-4" />}
                    {busy ? 'Opening PR…' : `Open PR for ${selectedMarts.length} mart(s)`}
                  </button>
                </div>
              </div>
            )}

            {dest === 'file' && (
              <div className="dm-card flex items-center gap-3">
                <button className={btnOutline} onClick={() => setStep(1)}><ArrowLeft className="h-4 w-4" /> Back</button>
                <button className={btnPrimary} onClick={runFile} disabled={busy} data-testid="run-file">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  {busy ? 'Building…' : `Download ${selectedMarts.length} mart(s)`}
                </button>
              </div>
            )}

            {progress && <div className="text-muted-foreground text-sm">{progress}</div>}
            {error && <Banner kind="error" text={error} />}
            {done && <Banner kind="ok" text={done} />}
          </div>
        )}
      </div>
    </div>
  );
}

// "Filters ▾" dropdown, matching the Data Marts page toolbar. Applies live; closes on outside click.
function FiltersMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="filters-toggle"
        className="hover:bg-accent focus-visible:ring-ring inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium focus-visible:ring-[3px] focus-visible:outline-none"
      >
        <Filter className="h-4 w-4" /> Filters <ChevronDown className="h-4 w-4" />
      </button>
      {open && (
        <div className="bg-card absolute z-30 mt-1 w-64 rounded-md border p-3 shadow-md" data-testid="filters-menu">
          {children}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </div>
  );
}

function Check({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className={'flex items-center gap-2 text-sm ' + (disabled ? 'text-muted-foreground' : '')}>
      <input type="checkbox" className="accent-primary size-4" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function DestCard({ icon, title, desc, selected, onClick, testid }: { icon: React.ReactNode; title: string; desc: string; selected: boolean; onClick: () => void; testid: string }) {
  return (
    <button onClick={onClick} data-testid={testid} className={'flex items-start gap-3 rounded-md border p-4 text-left transition-colors hover:bg-accent ' + (selected ? 'border-primary ring-primary ring-1' : '')}>
      <span className="text-primary mt-0.5">{icon}</span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="text-muted-foreground block text-sm">{desc}</span>
      </span>
    </button>
  );
}

function Banner({ kind, text }: { kind: 'error' | 'ok'; text: string }) {
  const Icon = kind === 'error' ? AlertCircle : CheckCircle2;
  return (
    <div className={'flex items-start gap-2 text-sm ' + (kind === 'error' ? 'text-destructive' : 'text-foreground')}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{text}</span>
    </div>
  );
}
