import type { PluginComponent } from '@owox-plugins/sdk';
import { useEffect, useState } from 'react';

const API = '/api/plugin/okf-export';

type Mart = { id: string; title: string; slug: string; type: string; storage: string };
type Status = {
  owox: boolean;
  github: boolean;
  last: { project?: string; count?: number; pushed?: string | null } | null;
};

async function getJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API + path, init);
  return r.json();
}

const OkfExport: PluginComponent = ({ hostApi }) => {
  const [status, setStatus] = useState<Status | null>(null);
  const [marts, setMarts] = useState<Mart[]>([]);
  const [doc, setDoc] = useState<{ slug: string; markdown: string } | null>(null);
  const [push, setPush] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    setStatus(await getJSON<Status>('/status'));
    setMarts((await getJSON<{ marts: Mart[] }>('/marts')).marts);
  };

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, []);

  const run = async () => {
    setRunning(true);
    setError('');
    setDoc(null);
    try {
      const res = await getJSON<{ ok: boolean; error?: string; pushed?: string | null }>('/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ push }),
      });
      if (!res.ok) {
        setError(res.error || 'Export failed');
        hostApi.toast(res.error || 'Export failed', 'error');
      } else {
        hostApi.toast(res.pushed ? `Exported & pushed: ${res.pushed}` : 'Export complete', 'success');
        await refresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const openDoc = async (slug: string) => {
    setDoc(await getJSON<{ slug: string; markdown: string }>(`/doc?slug=${encodeURIComponent(slug)}`));
  };

  if (!status) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1000 }}>
      <h1 style={{ margin: 0 }}>OKF Export</h1>

      <section style={{ fontSize: 14 }}>
        <div>OWOX API key: {status.owox ? '✓ configured' : '✗ not set'}</div>
        <div>GitHub push: {status.github ? '✓ configured' : '— not configured (export stays local)'}</div>
        {!status.owox && (
          <p style={{ color: '#b45309' }}>
            Set your OWOX API key in{' '}
            <a onClick={() => hostApi.navigate('plugin/okf-export/settings')} style={{ cursor: 'pointer', color: '#3b82f6' }}>
              Settings
            </a>{' '}
            first.
          </p>
        )}
      </section>

      <section style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={run} disabled={running || !status.owox} style={{ padding: '8px 16px', cursor: 'pointer' }}>
          {running ? 'Exporting…' : 'Run export'}
        </button>
        {status.github && (
          <label style={{ fontSize: 14 }}>
            <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} /> Push to GitHub
          </label>
        )}
        {status.last && (
          <span style={{ fontSize: 13, color: '#64748b' }}>
            Last: {status.last.count} mart(s) from “{status.last.project}”
            {status.last.pushed ? ` · ${status.last.pushed}` : ''}
          </span>
        )}
      </section>

      {error && <pre style={{ color: '#dc2626', whiteSpace: 'pre-wrap' }}>{error}</pre>}

      {marts.length > 0 && (
        <section style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 13, flex: '0 0 auto' }}>
            <thead>
              <tr><th style={th}>Data Mart</th><th style={th}>Type</th><th style={th}>Storage</th></tr>
            </thead>
            <tbody>
              {marts.map((m) => (
                <tr key={m.id}>
                  <td style={td}>
                    <a onClick={() => openDoc(m.slug)} style={{ cursor: 'pointer', color: '#3b82f6' }}>{m.title}</a>
                  </td>
                  <td style={td}>{m.type}</td>
                  <td style={td}>{m.storage}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {doc && (
            <pre style={{ flex: 1, background: '#f1f5f9', padding: 16, borderRadius: 6, overflowX: 'auto', fontSize: 12, lineHeight: 1.5 }}>
              {doc.markdown}
            </pre>
          )}
        </section>
      )}
    </div>
  );
};

const th: React.CSSProperties = { border: '1px solid #e2e8f0', padding: '4px 10px', textAlign: 'left', background: '#f8fafc' };
const td: React.CSSProperties = { border: '1px solid #e2e8f0', padding: '4px 10px' };

export default OkfExport;
