import { useEffect, useMemo, useState } from 'react';
import { SEVERITY_ORDER, filterFindings, modelFor, sortFindings } from '../lib/report-view.js';
import { Badge, Notice } from './ui.jsx';

const SEVERITY_TONE = { critical: 'danger', high: 'danger', medium: 'warn', low: 'info', info: 'neutral' };

function Investigation({ entry, model }) {
  return (
    <div className="ai-box" aria-label="Local model explanation">
      <h4>Local model explanation <span className="muted">advisory · not a finding</span></h4>
      {model && <p className="mono muted">{model.model}</p>}
      <dl className="ai-dl">
        <dt>What it appears to do</dt><dd>{entry.explanation}</dd>
        <dt>What could happen</dt><dd>{entry.implications}</dd>
        <dt>What is uncertain</dt><dd>{entry.uncertainty}</dd>
      </dl>
    </div>
  );
}

export default function Findings({ report, jump, onOpenFile }) {
  const [severity, setSeverity] = useState('all');
  useEffect(() => {
    if (!jump) return;
    setSeverity(jump.severity ?? 'all');
    if (jump.findingId) requestAnimationFrame(() => document.getElementById(`finding-${jump.findingId}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }, [jump]);

  const sorted = useMemo(() => sortFindings(report.findings), [report.findings]);
  const shown = filterFindings(sorted, severity);
  const filesById = useMemo(() => new Map(report.files.map((f) => [f.id, f])), [report.files]);
  const investigations = useMemo(() => new Map(report.ai.investigations.map((i) => [i.findingId, i])), [report.ai.investigations]);
  const model = modelFor(report, 'investigation');
  const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, report.findings.filter((f) => f.severity === s).length]));

  return (
    <div className="stack">
      <Notice title={report.findings.length === 0 ? 'No findings matched' : 'How to read these'}>
        {report.findings.length === 0
          ? 'The scanner matches patterns in text. An empty list means nothing matched, not that the package is safe.'
          : 'Findings are deterministic scanner matches with quoted evidence. They are indicators, not proof of intent, and a short list or low score does not mean the rest is safe.'}
      </Notice>

      {report.findings.length > 0 && (
        <div className="segmented" role="group" aria-label="Severity filter">
          <button type="button" aria-pressed={severity === 'all'} onClick={() => setSeverity('all')}>All {report.findings.length}</button>
          {SEVERITY_ORDER.filter((s) => counts[s] > 0).map((s) => (
            <button key={s} type="button" aria-pressed={severity === s} onClick={() => setSeverity(s)}>{s} {counts[s]}</button>
          ))}
        </div>
      )}

      <ol className="findings">
        {shown.map((finding) => {
          const file = finding.fileId ? filesById.get(finding.fileId) : null;
          const investigation = investigations.get(finding.id);
          return (
            <li key={finding.id} id={`finding-${finding.id}`} className={`finding sev-${SEVERITY_TONE[finding.severity]}`}>
              <header className="finding-head">
                <Badge tone={SEVERITY_TONE[finding.severity]}>{finding.severity}</Badge>
                <span className="mono rule">{finding.ruleId}</span>
                <span className="muted fine">{finding.id} · confidence {finding.confidence}</span>
              </header>
              <h3>{finding.title}</h3>
              <p className="desc">{finding.description}</p>
              <p className="fine inline">
                {finding.scope === 'package' ? <Badge variant="outline">Package-wide</Badge> : file ? (
                  <button type="button" className="link mono" onClick={() => onOpenFile(file.id)}>{file.path}</button>
                ) : null}
                {finding.introducedInPackage && <Badge tone="warn" variant="outline">New in the published package</Badge>}
              </p>
              <div className="evidence-list">
                <h4>Evidence</h4>
                {finding.evidence.map((item, i) => (
                  <figure key={i} className="snippet">
                    <figcaption className="mono">{item.path}{item.line ? `:${item.line}` : ''}{item.column ? `:${item.column}` : ''}{item.indicator && <span className="muted"> · {item.indicator}</span>}</figcaption>
                    <pre><code>{item.snippet}</code></pre>
                  </figure>
                ))}
              </div>
              {investigation && <Investigation entry={investigation} model={model} />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
