import { formatBytes, formatDuration, describeAiStatus } from '../lib/report-view.js';
import { Badge, Dot, KeyValue, Notice, Panel } from './ui.jsx';

const SEVERITY_TONE = { critical: 'danger', high: 'danger', medium: 'warn', low: 'info', info: 'neutral' };

function ScorePanel({ summary, report, onNavigate }) {
  const { score, scored } = summary;
  return (
    <Panel title="Risk score" id="score">
      {scored ? (
        <>
          <div className="score">
            <span className={`score-value tone-${summary.verdict.tone}`}>{score}</span>
            <span className="score-max">/ 100</span>
          </div>
          <div className="meter" role="img" aria-label={`Risk score ${score} out of 100`}>
            <span className={`meter-fill fill-${summary.verdict.tone}`} style={{ width: `${Math.min(100, score)}%` }} />
          </div>
          <p className="fine">
            {report.summary.scoring.model} · a transparent sum of finding weights, capped at {report.summary.scoring.cap}.{' '}
            <strong>A low score is not a statement that a package is safe.</strong>
          </p>
        </>
      ) : (
        <p className="lede">No security score: the scanner did not run for this report.</p>
      )}
      <button type="button" className="link" onClick={() => onNavigate('findings')}>
        View {summary.findingCount} finding{summary.findingCount === 1 ? '' : 's'}
      </button>
    </Panel>
  );
}

function SeverityPanel({ summary, onNavigate }) {
  const max = Math.max(1, ...summary.severities.map((s) => s.count));
  return (
    <Panel title="Findings by severity" id="severity">
      <ul className="bars">
        {summary.severities.map(({ name, count }) => (
          <li key={name}>
            <button type="button" className="bar-row" onClick={() => onNavigate('findings', { severity: name })} disabled={count === 0} aria-label={`${count} ${name} finding${count === 1 ? '' : 's'}`}>
              <span className="bar-label">{name}</span>
              <span className="bar-track"><span className={`bar-fill fill-${SEVERITY_TONE[name]}`} style={{ width: `${(count / max) * 100}%` }} /></span>
              <span className="bar-count mono">{count}</span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function DifferencePanel({ summary, onNavigate }) {
  const { counts } = summary;
  const total = counts.identical + counts.modified + counts.packageOnly + counts.sourceOnly;
  const parts = [
    ['identical', counts.identical, 'Identical'],
    ['modified', counts.modified, 'Modified'],
    ['package-only', counts.packageOnly, 'Package only'],
    ['source-only', counts.sourceOnly, 'Source only'],
  ];
  return (
    <Panel title="File comparison" id="compare">
      <div className="stackbar" role="img" aria-label={parts.map(([, n, l]) => `${n} ${l}`).join(', ')}>
        {parts.map(([key, n]) => n > 0 && <span key={key} className={`seg seg-${key}`} style={{ flexGrow: n }} />)}
      </div>
      <ul className="legend">
        {parts.map(([key, n, label]) => (
          <li key={key}><span className={`swatch seg-${key}`} aria-hidden="true" />{label} <span className="mono">{n}</span></li>
        ))}
      </ul>
      <p className="fine">
        {summary.differingCount === 0 ? (
          <>No published file differs from the source{total === 0 ? '.' : ` (${total} compared).`}</>
        ) : (
          <>
            {summary.differingCount} published file{summary.differingCount === 1 ? '' : 's'} differ: <strong>{summary.explainedCount} explained</strong> from
            evidence, <strong className={summary.unexplainedCount > 0 ? 'tone-warn' : undefined}>{summary.unexplainedCount} unexplained</strong>.
          </>
        )}
      </p>
      <button type="button" className="link" onClick={() => onNavigate('files', summary.unexplainedCount > 0 ? { filters: { focus: 'unexplained' } } : undefined)}>
        {summary.unexplainedCount > 0 ? 'Show unexplained files' : 'Open file explorer'}
      </button>
    </Panel>
  );
}

function IntegritySource({ summary, report }) {
  const { integrity, source } = summary;
  return (
    <Panel title="Integrity and source" id="integrity">
      <dl className="kvs">
        <KeyValue label="Tarball checksum">
          <span className="inline"><Dot state={integrity.state} />{integrity.label}</span>
          <span className="fine block">{integrity.detail}</span>
        </KeyValue>
        <KeyValue label="Source repository">
          {source.repositoryUrl ? <a href={source.repositoryUrl} target="_blank" rel="noopener noreferrer">{source.repository.replace('https://', '')}</a> : source.repository ?? 'Not resolved'}
          {source.directory && <span className="fine block">Directory: <span className="mono">{source.directory}</span></span>}
        </KeyValue>
        <KeyValue label="Source resolution">
          <span className="inline"><Dot state={source.state} />{source.label}</span>
          {source.commit && <span className="fine block mono">{source.commit.slice(0, 12)}</span>}
        </KeyValue>
        <KeyValue label="npm provenance">
          {report.package.provenance.attestationPresent ? 'Attestation present (not verified by Audyssey)' : 'No attestation'}
        </KeyValue>
        <KeyValue label="Published package">{report.package.fileCount} files · {formatBytes(report.package.totalBytes)}</KeyValue>
      </dl>
      {source.notes.length > 0 && (
        <details className="how">
          <summary>How the source was found</summary>
          <ul className="plain">{source.notes.map((note) => <li key={note}>{note}</li>)}</ul>
        </details>
      )}
    </Panel>
  );
}

function CoveragePanel({ summary }) {
  const { scan } = summary;
  return (
    <Panel title="Scan coverage" id="coverage">
      {scan.performed ? (
        <dl className="kvs">
          <KeyValue label="Files scanned"><span className="mono">{scan.scanned}</span></KeyValue>
          <KeyValue label="Not applicable"><span className="mono">{scan.notApplicable}</span><span className="fine block">Files with no scannable text (documentation, data).</span></KeyValue>
          <KeyValue label="Skipped"><span className="mono">{scan.skipped}</span>{scan.skipped > 0 && <span className="fine block tone-warn">Skipped files were not scanned: no findings there means nothing.</span>}</KeyValue>
          <KeyValue label="Rules">{scan.ruleCount} rules · version <span className="mono">{scan.rulesVersion}</span></KeyValue>
          <KeyValue label="Capability differential">
            <span className="inline"><Dot state={scan.differentialAvailable ? 'ok' : 'neutral'} />{scan.differentialAvailable ? 'Compared with source' : 'Unavailable'}</span>
            <span className="fine block">{scan.differentialBasis}</span>
          </KeyValue>
        </dl>
      ) : (
        <Notice tone="warn" title="No scan was performed">The verdict is inconclusive and no score exists.</Notice>
      )}
    </Panel>
  );
}

function AiStatusPanel({ summary, onNavigate }) {
  const { ai } = summary;
  return (
    <Panel title="Local AI" id="ai-status">
      <p className="inline"><Dot state={ai.status === 'completed' ? 'ok' : ai.status === 'skipped' ? 'neutral' : 'warn'} /><strong>{describeAiStatus(ai.status)}</strong></p>
      {ai.runs.length > 0 ? (
        <ul className="plain">
          {ai.runs.map((run) => (
            <li key={run.stage}><span className="mono">{run.model}</span> · {run.stage} · {run.status} · {formatDuration(run.durationMs)}</li>
          ))}
        </ul>
      ) : (
        <p className="fine">No model was called for this report.</p>
      )}
      <p className="fine">Model output is advisory and kept apart from the deterministic analysis. It never changes a finding, the score or the verdict.</p>
      {ai.runs.length > 0 && <button type="button" className="link" onClick={() => onNavigate('ai')}>See model output</button>}
    </Panel>
  );
}

function ScoreBreakdown({ report }) {
  const { scoring } = report.summary;
  if (!scoring || scoring.contributions.length === 0) return null;
  return (
    <Panel title="Score breakdown" id="breakdown" aside={<span className="muted mono">raw {scoring.rawTotal} → {report.summary.riskScore}</span>}>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Finding</th><th scope="col">Rule</th><th scope="col" className="num">Base</th><th scope="col" className="num">Confidence</th><th scope="col" className="num">New in pkg</th><th scope="col" className="num">Repeat</th><th scope="col" className="num">Points</th></tr></thead>
          <tbody>
            {scoring.contributions.map((c) => (
              <tr key={c.findingId}>
                <td className="mono">{c.findingId}</td><td className="mono">{c.ruleId}</td>
                <td className="num mono">{c.base}</td><td className="num mono">×{c.confidenceFactor}</td><td className="num mono">×{c.introducedFactor}</td><td className="num mono">×{c.repeatFactor}</td>
                <td className="num mono"><strong>{c.points}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ManifestPanel({ report }) {
  const { manifest } = report;
  if (!manifest.compared) return <Panel title="package.json comparison" id="manifest"><p className="fine">Not compared{manifest.reason ? `: ${manifest.reason}` : '.'}</p></Panel>;
  const pkgScripts = Object.entries(manifest.installScripts.package);
  return (
    <Panel title="package.json comparison" id="manifest">
      {manifest.changes.length === 0 ? <p className="fine">The published package.json matches the source.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Field</th><th scope="col">Change</th><th scope="col">Published</th><th scope="col">Source</th></tr></thead>
            <tbody>
              {manifest.changes.map((change) => (
                <tr key={change.field}>
                  <td className="mono">{change.field}</td><td><Badge tone={change.change === 'added' ? 'warn' : 'neutral'} variant="outline">{change.change}</Badge></td>
                  <td className="mono wrap">{change.packageValue === null ? '—' : String(change.packageValue)}</td><td className="mono wrap">{change.sourceValue === null ? '—' : String(change.sourceValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pkgScripts.length > 0 && (
        <p className="fine">Install-time scripts in the published package: {pkgScripts.map(([name, cmd]) => <span key={name} className="mono chip-inline">{name}: {cmd}</span>)}</p>
      )}
    </Panel>
  );
}

export default function Overview({ report, summary, onNavigate }) {
  return (
    <div className="stack">
      <section className={`hero hero-${summary.verdict.tone}`} aria-labelledby="verdict-heading">
        <div className="hero-main">
          <p className="eyebrow">{summary.inputKind} · npm</p>
          <h2 className="hero-title mono">{summary.name}<span className="at">@</span>{summary.version}</h2>
          <p className="fine">Analysed {new Date(report.generatedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC · {report.tool.name} {report.tool.version} · schema {report.schemaVersion}</p>
        </div>
        <div className="hero-verdict">
          <Badge tone={summary.verdict.tone}>Verdict</Badge>
          <h3 id="verdict-heading" className={`verdict tone-${summary.verdict.tone}`}>{summary.verdict.label}</h3>
          <p>{summary.verdict.headline}</p>
        </div>
        <p className="hero-detail">{summary.verdict.detail}</p>
      </section>

      {summary.errors.length > 0 && (
        <Notice tone="warn" title="Problems recorded during analysis">
          <ul className="plain">{summary.errors.map((e, i) => <li key={`${e.stage}-${i}`}><span className="mono">{e.stage}</span>: {e.message}</li>)}</ul>
        </Notice>
      )}

      <div className="grid-3">
        <ScorePanel summary={summary} report={report} onNavigate={onNavigate} />
        <SeverityPanel summary={summary} onNavigate={onNavigate} />
        <DifferencePanel summary={summary} onNavigate={onNavigate} />
      </div>
      <div className="grid-3">
        <IntegritySource summary={summary} report={report} />
        <CoveragePanel summary={summary} />
        <AiStatusPanel summary={summary} onNavigate={onNavigate} />
      </div>
      <ManifestPanel report={report} />
      <ScoreBreakdown report={report} />
    </div>
  );
}
