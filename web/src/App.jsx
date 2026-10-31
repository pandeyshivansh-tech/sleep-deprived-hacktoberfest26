import { useCallback, useEffect, useMemo, useState } from 'react';
import { describeHealth } from './lib/health.js';
import { buildFileRows, summarizeReport } from './lib/report-view.js';
import AiPanel from './components/AiPanel.jsx';
import FileExplorer from './components/FileExplorer.jsx';
import Findings from './components/Findings.jsx';
import Overview from './components/Overview.jsx';
import SystemStatus from './components/SystemStatus.jsx';
import Workspace from './components/Workspace.jsx';
import { Badge, Icon } from './components/ui.jsx';

async function fetchHealth() {
  const response = await fetch('/api/health', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Server responded with HTTP ${response.status}`);
  return response.json();
}

function useHealth() {
  const [result, setResult] = useState({ health: null, error: null });
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setResult({ health: await fetchHealth(), error: null });
    } catch (error) {
      setResult({ health: null, error: error.message });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { view: describeHealth(result), loading, refresh };
}

const TITLES = { workspace: 'Analysis workspace', overview: 'Overview', files: 'File comparison', findings: 'Security findings', ai: 'Local AI analysis' };

export default function App() {
  const { view: health, loading, refresh } = useHealth();
  const [loaded, setLoaded] = useState(null); // { report, label }
  const [page, setPage] = useState('workspace');
  const [jump, setJump] = useState(null);

  const summary = useMemo(() => (loaded ? summarizeReport(loaded.report) : null), [loaded]);
  const rows = useMemo(() => (loaded ? buildFileRows(loaded.report) : []), [loaded]);

  const go = useCallback((next, detail) => {
    setPage(next);
    setJump(detail ? { ...detail, nonce: Date.now() } : null);
    window.scrollTo({ top: 0 });
  }, []);

  const nav = [
    ['workspace', 'Workspace', 'open', null],
    ...(loaded
      ? [
          ['overview', 'Overview', 'overview', null],
          ['files', 'Files', 'files', loaded.report.files.length],
          ['findings', 'Findings', 'findings', loaded.report.findings.length],
          ['ai', 'Local AI', 'ai', null],
        ]
      : []),
  ];

  return (
    <div className="app">
      <a className="skip" href="#main">Skip to content</a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Icon name="logo" size={18} /></span>
          <div>
            <p className="brand-name">Audyssey</p>
            <p className="brand-tag">Know what you're actually installing.</p>
          </div>
        </div>
        <nav aria-label="Dashboard">
          <ul className="nav">
            {nav.map(([id, label, icon, count]) => (
              <li key={id}>
                <button type="button" className="nav-item" aria-current={page === id ? 'page' : undefined} onClick={() => go(id)}>
                  <Icon name={icon} />
                  <span>{label}</span>
                  {count !== null && <span className="nav-count mono">{count}</span>}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <SystemStatus view={health} loading={loading} onRefresh={refresh} />
      </aside>

      <div className="content">
        <header className="topbar">
          <h1 className="page-title">{TITLES[page]}</h1>
          {loaded && page !== 'workspace' && (
            <div className="topbar-pkg">
              <span className="mono">{summary.name}@{summary.version}</span>
              <Badge tone={summary.verdict.tone}>{summary.verdict.label}</Badge>
              <button type="button" className="link" onClick={() => { setLoaded(null); go('workspace'); }}>Close report</button>
            </div>
          )}
        </header>
        <main id="main" className="main" tabIndex={-1}>
          {page === 'workspace' && (
            <>
              {loaded && (
                <div className="current">
                  <span>Open: <strong className="mono">{loaded.label}</strong></span>
                  <button type="button" className="btn" onClick={() => go('overview')}>Back to report</button>
                </div>
              )}
              <Workspace onOpen={(report, label) => { setLoaded({ report, label }); go('overview'); }} />
            </>
          )}
          {loaded && page === 'overview' && <Overview report={loaded.report} summary={summary} onNavigate={go} />}
          {loaded && page === 'files' && (
            <FileExplorer report={loaded.report} rows={rows} jump={jump} onOpenFinding={(findingId) => go('findings', { findingId })} />
          )}
          {loaded && page === 'findings' && <Findings report={loaded.report} jump={jump} onOpenFile={(fileId) => go('files', { fileId })} />}
          {loaded && page === 'ai' && (
            <AiPanel report={loaded.report} onOpenFile={(fileId) => go('files', { fileId })} onOpenFinding={(findingId) => go('findings', { findingId })} />
          )}
        </main>
      </div>
    </div>
  );
}
