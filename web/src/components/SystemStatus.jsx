import { Dot } from './ui.jsx';

export default function SystemStatus({ view, loading, onRefresh }) {
  return (
    <section className="system" aria-labelledby="system-heading" aria-busy={loading}>
      <div className="system-head">
        <h2 id="system-heading">System</h2>
        <button type="button" className="link" onClick={onRefresh} disabled={loading}>{loading ? 'Checking…' : 'Refresh'}</button>
      </div>
      <ul className="system-list">
        <li><Dot state={view.server.state} /><span>API server</span><span className="muted">{view.server.label}</span></li>
        <li><Dot state={view.ollama.state} /><span>Ollama</span><span className="muted">{view.ollama.label}</span></li>
        {view.models.map((m) => <li key={m.name}><Dot state={m.state} /><span className="mono">{m.name}</span><span className="muted">{m.label.split('.')[0]}</span></li>)}
      </ul>
      {view.server.detail && <p className="fine">{view.server.detail}</p>}
      <p className="fine">{view.ai.label}</p>
    </section>
  );
}
