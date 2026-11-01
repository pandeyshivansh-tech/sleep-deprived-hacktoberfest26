import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { MAX_UPLOAD_BYTES, checkUploadFile, formatMegabytes, runAnalysis } from '../lib/analysis-client.js';
import { formatBytes } from '../lib/report-view.js';
import { Badge, Icon, Panel } from './ui.jsx';

const STATE_TEXT = { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed' };
const STATE_TONE = { queued: 'neutral', running: 'info', completed: 'ok', failed: 'danger' };

// Real job state only: everything shown here is what the server reported. There is
// no percentage because the pipeline has no way to know one.
export default function UploadAnalysis({ aiReady, aiNote, onComplete }) {
  const [file, setFile] = useState(null);
  const [problem, setProblem] = useState(null);
  const [ai, setAi] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [run, setRun] = useState({ phase: 'idle', job: null, message: null, failure: null });
  const controller = useRef(null);
  const input = useRef(null);
  const busy = run.phase === 'uploading' || run.phase === 'job';

  useEffect(() => () => controller.current?.abort(), []);

  function choose(candidate) {
    if (!candidate) return;
    const check = checkUploadFile(candidate);
    setRun({ phase: 'idle', job: null, message: null, failure: null });
    if (!check.ok) {
      setFile(null);
      setProblem(check.message);
      return;
    }
    setProblem(null);
    setFile(candidate);
  }

  async function analyze() {
    controller.current = new AbortController();
    setRun({ phase: 'uploading', job: null, message: null, failure: null });
    const result = await runAnalysis({
      file,
      ai: ai && aiReady,
      signal: controller.current.signal,
      onUpdate: (update) => setRun((current) => ({ ...current, phase: update.phase, job: update.job ?? current.job, message: update.message })),
    });
    if (result.status === 'completed') {
      setRun({ phase: 'idle', job: null, message: null, failure: null });
      onComplete(result.report, `${result.report.package.name}@${result.report.package.version} — analysed from ${file.name}`);
    } else if (result.status === 'aborted') {
      setRun({ phase: 'idle', job: null, message: null, failure: null });
    } else {
      setRun({ phase: 'failed', job: result.job ?? null, message: null, failure: result });
    }
  }

  const job = run.job;
  return (
    <Panel title="Analyze a package (.tgz)" id="upload" aside={<Badge tone="info" variant="outline">Live analysis</Badge>}>
      <p className="lede">
        Upload an npm package archive (the <code>.tgz</code> from <code>npm pack</code> or the registry, up to {formatMegabytes(MAX_UPLOAD_BYTES)}).
        Audyssey reads it in memory, finds the matching source on GitHub through the npm registry, and compares them. Nothing in the
        package is run or installed, and the file is not stored.
      </p>
      <div
        className={`dropzone${dragging ? ' is-dragging' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); if (!busy) choose(event.dataTransfer.files?.[0]); }}
      >
        <Icon name="open" size={20} />
        <div>
          <strong>{file ? file.name : 'Drop a package .tgz here'}</strong>
          {file && <span className="muted mono"> · {formatBytes(file.size)}</span>}
          <span className="muted"> {file ? '' : 'or '}</span>
          <button type="button" className="btn" onClick={() => input.current?.click()} disabled={busy}>{file ? 'Change file' : 'Choose a file'}</button>
          <input ref={input} type="file" accept=".tgz,.tar.gz,application/gzip,application/x-gzip" className="visually-hidden" aria-label="Choose an npm package .tgz archive" onChange={(event) => { choose(event.target.files?.[0]); event.target.value = ''; }} />
        </div>
      </div>
      {problem && <div className="failure" role="alert"><strong>Cannot use this file</strong><p>{problem}</p></div>}

      <label className={`check${aiReady ? '' : ' is-disabled'}`}>
        <input type="checkbox" checked={ai && aiReady} disabled={!aiReady || busy} onChange={(event) => setAi(event.target.checked)} />
        <span>
          Also interpret with the local models <span className="mono muted">gemma4:e4b → deepseek-r1:8b</span>
          <span className="fine block">{aiReady ? 'Advisory only; slower (can take a few minutes). Runs through your local Ollama.' : aiNote}</span>
        </span>
      </label>

      <div className="inline">
        <button type="button" className="btn btn-primary" onClick={analyze} disabled={!file || busy}>{busy ? 'Analyzing…' : 'Analyze'}</button>
        {busy && <button type="button" className="link" onClick={() => controller.current?.abort()}>Stop watching</button>}
      </div>

      {(busy || job) && run.phase !== 'failed' && (
        <div className="job" role="status" aria-live="polite">
          <p className="inline">
            <Badge tone={STATE_TONE[job?.state] ?? 'info'}>{job ? STATE_TEXT[job.state] ?? job.state : 'Uploading'}</Badge>
            {job?.state === 'queued' && job.queuePosition ? <span className="fine">position {job.queuePosition} in the queue</span> : null}
            {!job && <span className="fine">Sending the archive to the server…</span>}
          </p>
          {job?.progress.length > 0 && (
            <ol className="steps">
              {job.progress.map((step, index) => (
                <motion.li layout initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.25 }} key={`${step.at}-${index}`} className={index === job.progress.length - 1 && job.state === 'running' ? 'is-current' : undefined}>{step.message}</motion.li>
              ))}
            </ol>
          )}
          {run.message && <p className="fine tone-warn">{run.message}</p>}
          {job?.ai && <p className="fine">Local model steps can take a few minutes. Stopping the watch does not cancel the analysis on the server.</p>}
        </div>
      )}

      {run.phase === 'failed' && run.failure && (
        <div className="failure" role="alert">
          <strong>{run.failure.kind === 'busy' ? 'Server busy' : run.failure.kind === 'network' ? 'Server unreachable' : 'Analysis did not complete'}</strong>
          <p>{run.failure.message}</p>
          {run.failure.problems?.length > 0 && <ul className="problems">{run.failure.problems.map((p) => <li key={p} className="mono">{p}</li>)}</ul>}
          {run.failure.job?.progress.length > 0 && <p className="fine muted">Last step: {run.failure.job.progress.at(-1).message}</p>}
        </div>
      )}
    </Panel>
  );
}
