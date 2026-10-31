import { useRef, useState } from 'react';
import { acceptReport, MAX_REPORT_BYTES, parseReportText } from '../lib/report-load.js';
import { BUNDLED_REPORTS } from '../lib/examples.js';
import { describeVerdict } from '../lib/report-view.js';
import UploadAnalysis from './UploadAnalysis.jsx';
import { Badge, Icon, Notice, Panel } from './ui.jsx';

const FAILURE_TITLES = {
  empty: 'Empty file',
  'too-large': 'File too large',
  'not-json': 'Not a JSON file',
  'not-a-report': 'Not an Audyssey report',
  'wrong-version': 'Unsupported report version',
  invalid: 'Invalid report',
  unreadable: 'Could not read the file',
};

export default function Workspace({ onOpen, aiReady, aiNote }) {
  const [state, setState] = useState({ phase: 'idle', failure: null, name: null });
  const [dragging, setDragging] = useState(false);
  const input = useRef(null);

  async function openFile(file) {
    if (!file) return;
    setState({ phase: 'reading', failure: null, name: file.name });
    if (file.size > MAX_REPORT_BYTES) {
      setState({ phase: 'failed', name: file.name, failure: { kind: 'too-large', message: 'The file is larger than any Audyssey report.', problems: [], moreProblems: 0 } });
      return;
    }
    let text;
    try {
      text = await file.text();
    } catch {
      setState({ phase: 'failed', name: file.name, failure: { kind: 'unreadable', message: 'The browser could not read this file.', problems: [], moreProblems: 0 } });
      return;
    }
    const result = parseReportText(text);
    if (result.ok) {
      setState({ phase: 'idle', failure: null, name: null });
      onOpen(result.report, file.name, 'file');
    } else {
      setState({ phase: 'failed', failure: result, name: file.name });
    }
  }

  function openBundled(entry) {
    const result = acceptReport(entry.report);
    if (result.ok) onOpen(result.report, `${entry.title} (bundled example)`, 'example');
    else setState({ phase: 'failed', failure: result, name: entry.title });
  }

  const { failure } = state;
  return (
    <div className="stack">
      <UploadAnalysis aiReady={aiReady} aiNote={aiNote} onComplete={(report, label) => onOpen(report, label, 'upload')} />
      <Panel title="Open an existing report" id="open">
        <p className="lede">
          Load a <code>report.json</code> produced by the Audyssey CLI. It is checked against the report contract in your browser
          before anything is shown, and it is never uploaded anywhere.
        </p>
        <div
          className={`dropzone${dragging ? ' is-dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            openFile(event.dataTransfer.files?.[0]);
          }}
        >
          <Icon name="open" size={20} />
          <div>
            <strong>{state.phase === 'reading' ? `Reading ${state.name}…` : 'Drop a report.json here'}</strong>
            <span className="muted"> or </span>
            <button type="button" className="btn" onClick={() => input.current?.click()} disabled={state.phase === 'reading'}>
              Choose a file
            </button>
            <input
              ref={input}
              type="file"
              accept=".json,application/json"
              className="visually-hidden"
              aria-label="Choose an Audyssey report.json file"
              onChange={(event) => {
                openFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </div>
        </div>

        {failure && (
          <div className="failure" role="alert">
            <strong>{FAILURE_TITLES[failure.kind] ?? 'Cannot open this file'}</strong>
            {state.name && <span className="mono muted"> · {state.name}</span>}
            <p>{failure.message}</p>
            {failure.problems.length > 0 && (
              <ul className="problems">
                {failure.problems.map((problem) => (
                  <li key={problem} className="mono">{problem}</li>
                ))}
                {failure.moreProblems > 0 && <li>…and {failure.moreProblems} more</li>}
              </ul>
            )}
          </div>
        )}

        <details className="how">
          <summary>How do I produce a report?</summary>
          <pre className="code"><code>npm run analyze -- name@1.2.3 --out report.json</code></pre>
          <p className="muted">
            Add <code>--ai</code> for local-model interpretation (needs Ollama). To analyze a package from this page, use the upload
            above.
          </p>
        </details>
      </Panel>

      <Panel title="Bundled example reports" id="examples" aside={<span className="muted">Real tool output</span>}>
        <p className="lede">
          These three reports were produced by the Audyssey CLI and are committed in <code>examples/</code>. They are the only
          analyses available without opening a file.
        </p>
        <ul className="example-list">
          {BUNDLED_REPORTS.map((entry) => {
            const verdict = describeVerdict(entry.report.summary.verdict);
            return (
              <li key={entry.id}>
                <button type="button" className="example" onClick={() => openBundled(entry)}>
                  <span className="example-main">
                    <strong className="mono">{entry.title}</strong>
                    <span className="muted">{entry.note}</span>
                  </span>
                  <Badge tone={verdict.tone}>{verdict.label}</Badge>
                  <Icon name="chevron" />
                </button>
              </li>
            );
          })}
        </ul>
      </Panel>

      <Notice title="What a report can and cannot tell you">
        The scanner matches patterns in text and the explainer matches files to source. A clean result means nothing matched, not
        that a package is safe.
      </Notice>
    </div>
  );
}
