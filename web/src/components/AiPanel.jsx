import { AI_LABEL_TEXT, describeAiStatus, formatDuration, shortHash } from '../lib/report-view.js';
import { Badge, Notice, Panel } from './ui.jsx';

export default function AiPanel({ report, onOpenFile, onOpenFinding }) {
  const { ai } = report;
  const files = new Map(report.files.map((f) => [f.id, f]));
  const notes = report.errors.filter((e) => e.stage === 'ai');
  return (
    <div className="stack">
      <Notice title="Advisory only">
        Local models (<span className="mono">gemma4:e4b</span> and <span className="mono">deepseek-r1:8b</span> through Ollama on this machine) interpret what the
        deterministic analysis found. Their text is not evidence. It cannot add, remove or change a finding, the score or the verdict, and the CLI checks that.
      </Notice>
      <Panel title="Status" id="ai-run" aside={<Badge tone={ai.status === 'completed' ? 'ok' : 'neutral'} variant="outline">{ai.status}</Badge>}>
        <p className="lede">{describeAiStatus(ai.status)}.</p>
        {ai.status === 'skipped' && <p className="fine">Run the CLI with <code>--ai</code> and Ollama running to add model interpretation.</p>}
        {notes.length > 0 && <ul className="plain">{notes.map((n, i) => <li key={i} className="fine">{n.message}</li>)}</ul>}
        {ai.runs.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Stage</th><th scope="col">Model</th><th scope="col">Digest</th><th scope="col" className="num">Duration</th><th scope="col">Status</th></tr></thead>
              <tbody>{ai.runs.map((run) => (
                <tr key={run.stage}><td>{run.stage}</td><td className="mono">{run.model}</td><td className="mono" title={run.digest ?? ''}>{shortHash(run.digest)}</td><td className="num mono">{formatDuration(run.durationMs)}</td><td>{run.status}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Panel>

      {ai.classifications.length > 0 && (
        <Panel title="File classifications" id="ai-class">
          <ul className="ai-list">
            {ai.classifications.map((entry) => {
              const file = files.get(entry.fileId);
              return (
                <li key={entry.fileId}>
                  <div className="inline"><Badge tone="ai" variant="outline">{AI_LABEL_TEXT[entry.label] ?? entry.label}</Badge>
                    <button type="button" className="link mono" onClick={() => onOpenFile(entry.fileId)}>{file?.path ?? entry.fileId}</button></div>
                  <p className="fine">{entry.rationale}</p>
                  {file && <p className="fine muted">Deterministic category: {file.explanation.category}</p>}
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {ai.investigations.length > 0 && (
        <Panel title="Finding investigations" id="ai-inv">
          <ul className="ai-list">
            {ai.investigations.map((entry) => (
              <li key={entry.findingId}>
                <button type="button" className="link mono" onClick={() => onOpenFinding(entry.findingId)}>{entry.findingId}</button>
                <p>{entry.explanation}</p>
                <p className="fine muted">Uncertainty: {entry.uncertainty}</p>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
