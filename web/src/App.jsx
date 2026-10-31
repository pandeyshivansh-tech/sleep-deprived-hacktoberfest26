import { useCallback, useEffect, useState } from 'react';
import { describeHealth } from './lib/health.js';

async function fetchHealth() {
  const response = await fetch('/api/health', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Server responded with HTTP ${response.status}`);
  return response.json();
}

function StatusRow({ label, state, value, detail }) {
  return (
    <div className="status-row">
      <span className={`dot dot-${state}`} aria-hidden="true" />
      <div className="status-text">
        <div className="status-label">{label}</div>
        <div className="status-value">{value}</div>
        {detail && <div className="status-detail">{detail}</div>}
      </div>
    </div>
  );
}

export default function App() {
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

  const view = describeHealth(result);

  return (
    <div className="page">
      <header className="header">
        <h1 className="brand">PackageLens</h1>
        <p className="tagline">Know what you're actually installing.</p>
      </header>

      <main>
        <section className="card" aria-labelledby="status-heading" aria-busy={loading}>
          <div className="card-header">
            <h2 id="status-heading">System status</h2>
            <button type="button" onClick={refresh} disabled={loading}>
              {loading ? 'Checking…' : 'Refresh'}
            </button>
          </div>

          <StatusRow label="API server" state={view.server.state} value={view.server.label} detail={view.server.detail} />
          <StatusRow label="Local Ollama" state={view.ollama.state} value={view.ollama.label} detail={view.ollama.detail} />
          {view.models.map((model) => (
            <StatusRow key={model.name} label={`${model.name} · ${model.role}`} state={model.state} value={model.label} />
          ))}
          <StatusRow label="AI explanations" state={view.ai.ready ? 'ok' : 'unknown'} value={view.ai.label} />
        </section>

        <p className="note">
          Package analysis is not available yet. This build only reports whether the server and the local models are ready.
        </p>
      </main>
    </div>
  );
}
