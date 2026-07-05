import { useEffect, useState } from 'react';
import { storage, backend, ui } from '@owox/plugin-sdk';
import { BookMarked, FileText, Loader2, Play } from 'lucide-react';

type Mart = { id: string; title: string; slug: string; type: string; storage: string };
type Summary = { count: number; pushed: boolean; at: string } | null;

const cellCls = 'border-b px-3 py-2';

export function App() {
  const [marts, setMarts] = useState<Mart[]>([]);
  const [summary, setSummary] = useState<Summary>(null);
  const [doc, setDoc] = useState<{ slug: string; md: string } | null>(null);
  const [push, setPush] = useState(false);
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);

  // Reads are brokered (async). No settings — the plugin is configured entirely by
  // its granted credentials (data-mart required; github + ai-provider optional). The
  // push target repo is remembered in host storage (persistence lives there, §5).
  async function reload() {
    setMarts(((await storage.get('marts')) as Mart[]) ?? []);
    setSummary(((await storage.get('summary')) as Summary) ?? null);
  }
  useEffect(() => {
    reload().catch(() => {});
    storage.get('github-repo').then((v) => { if (typeof v === 'string') setRepo(v); }).catch(() => {});
  }, []);

  function onRepoChange(v: string) {
    setRepo(v);
    storage.set('github-repo', v).catch(() => {});
  }

  async function run() {
    setBusy(true);
    setDoc(null);
    try {
      const out = (await backend.call('exportMarts', { push, repo })) as { count: number; pushed: boolean };
      ui.toast(out.pushed ? `Exported & pushed ${out.count} mart(s)` : `Exported ${out.count} mart(s)`);
    } catch (e) {
      ui.toast(`Failed: ${(e as Error).message}`);
    } finally {
      await reload().catch(() => {}); // docs were persisted even if the push step failed
      setBusy(false);
    }
  }

  async function openDoc(slug: string) {
    const md = (await storage.get(`doc:${slug}`)) as string;
    setDoc({ slug, md: md ?? '' });
  }

  return (
    <div className="dm-page bg-background text-foreground">
      <header className="dm-page-header">
        <div className="flex items-center justify-between gap-4">
          <h1 className="dm-page-header-title">OKF Export</h1>
          <button
            onClick={run}
            disabled={busy}
            data-testid="runExport"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary-hover focus-visible:ring-ring focus-visible:ring-[3px] focus-visible:outline-none disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {busy ? 'Exporting…' : 'Run export'}
          </button>
        </div>
      </header>

      <div className="dm-page-content flex flex-col gap-4 pb-12">
        <p className="text-muted-foreground max-w-2xl text-sm">
          Export OWOX Data Marts to an Open Knowledge Format bundle. Credentials are brokered by the
          host — the plugin stores none. Pushing to GitHub uses the optional GitHub permission.
        </p>

        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={push}
              onChange={(e) => setPush(e.target.checked)}
              className="accent-primary size-4"
            />
            Push to GitHub
          </label>
          {push && (
            <input
              type="text"
              value={repo}
              onChange={(e) => onRepoChange(e.target.value)}
              placeholder="owner/repo"
              aria-label="GitHub repo"
              className="border-input focus-visible:ring-ring h-8 w-56 rounded-md border bg-transparent px-3 shadow-xs focus-visible:ring-[3px] focus-visible:outline-none"
            />
          )}
          {summary && (
            <span className="text-muted-foreground text-xs">
              Last: {summary.count} mart(s){summary.pushed ? ' · pushed' : ''}
            </span>
          )}
        </div>

        {marts.length === 0 ? (
          <div className="dm-empty-state">
            <BookMarked className="dm-empty-state-ico" />
            <h2 className="dm-empty-state-title">No exported marts yet</h2>
            <p className="dm-empty-state-subtitle">
              Run an export to generate an OKF document for each data mart.
            </p>
          </div>
        ) : (
          <div className="flex items-start gap-6">
            <div className="dm-card shrink-0 overflow-hidden p-0">
              <table className="text-sm" data-testid="martsTable">
                <thead>
                  <tr className="text-muted-foreground text-left">
                    <th className={`${cellCls} font-medium`}>Data Mart</th>
                    <th className={`${cellCls} font-medium`}>Type</th>
                    <th className={`${cellCls} font-medium`}>Storage</th>
                  </tr>
                </thead>
                <tbody>
                  {marts.map((m) => (
                    <tr key={m.id} className="hover:bg-accent">
                      <td className={cellCls}>
                        <button
                          onClick={() => openDoc(m.slug)}
                          className="text-primary inline-flex items-center gap-1.5 hover:underline"
                        >
                          <FileText className="h-3.5 w-3.5" />
                          {m.title}
                        </button>
                      </td>
                      <td className={cellCls}>{m.type}</td>
                      <td className={cellCls}>{m.storage}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {doc && (
              <pre className="bg-card text-card-foreground flex-1 overflow-x-auto rounded-md border p-4 text-xs leading-relaxed">
                {doc.md}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
