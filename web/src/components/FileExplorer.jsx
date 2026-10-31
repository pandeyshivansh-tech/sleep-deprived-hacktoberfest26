import { useEffect, useMemo, useState } from 'react';
import { AI_LABEL_TEXT, CATEGORY_LABELS, CATEGORY_ORDER, DEFAULT_FILTERS, STATUS_LABELS, STATUS_ORDER, countBy, filterFiles, formatBytes, modelFor, shortHash } from '../lib/report-view.js';
import { Badge, Icon } from './ui.jsx';

const PAGE = 120;
const CATEGORY_TONE = { identical: 'neutral', 'generated-artifact': 'info', 'publish-normalization': 'info', 'not-published': 'neutral', unexplained: 'warn', unclassified: 'neutral' };
const STATUS_TONE = { identical: 'neutral', modified: 'warn', 'package-only': 'warn', 'source-only': 'neutral' };
const SEVERITY_TONE = { critical: 'danger', high: 'danger', medium: 'warn', low: 'info', info: 'neutral' };
const FOCUS = [
  ['all', 'All'],
  ['unexplained', 'Unexplained'],
  ['findings', 'With findings'],
  ['ai-disagrees', 'Model flagged'],
];

function HashLine({ label, record }) {
  if (!record) return <div className="hashline"><span>{label}</span><span className="muted">not present</span></div>;
  return (
    <div className="hashline">
      <span>{label}</span>
      <span className="mono wrap" title={record.sha256}>{record.sha256}</span>
      <span className="muted mono">{formatBytes(record.size)}{record.type !== 'file' ? ` · ${record.type}` : ''}</span>
    </div>
  );
}

function FileDetail({ row, report, onOpenFinding }) {
  const model = modelFor(report, 'classification');
  return (
    <div className="detail" id={`detail-${row.id}`}>
      <div className="detail-col">
        <h4>Deterministic explanation</h4>
        <p className="inline">
          <Badge tone={CATEGORY_TONE[row.explanation.category]} variant={row.unexplained ? 'solid' : 'outline'}>{CATEGORY_LABELS[row.explanation.category]}</Badge>
          <span className="muted">confidence {row.explanation.confidence}</span>
        </p>
        <ul className="evidence">
          {row.explanation.evidence.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
        {row.opinion && (
          <div className="ai-box" aria-label="Local model opinion">
            <h4>Local model opinion <span className="muted">advisory · not evidence</span></h4>
            <p className="inline"><Badge tone="ai" variant="outline">{AI_LABEL_TEXT[row.opinion.label] ?? row.opinion.label}</Badge>{model && <span className="mono muted">{model.model}</span>}</p>
            <p>{row.opinion.rationale}</p>
          </div>
        )}
      </div>
      <div className="detail-col">
        <h4>Hashes (SHA-256)</h4>
        <HashLine label="Package" record={row.package} />
        <HashLine label="Source" record={row.source} />
        {row.findings.length > 0 && (
          <>
            <h4>Findings on this file</h4>
            <ul className="plain">
              {row.findings.map((finding) => (
                <li key={finding.id}>
                  <button type="button" className="link" onClick={() => onOpenFinding(finding.id)}>
                    <Badge tone={SEVERITY_TONE[finding.severity]}>{finding.severity}</Badge> <span className="mono">{finding.ruleId}</span> — {finding.title}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

export default function FileExplorer({ report, rows, jump, onOpenFinding }) {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [open, setOpen] = useState(() => new Set());
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    if (!jump) return;
    setFilters({ ...DEFAULT_FILTERS, ...(jump.filters ?? {}) });
    setLimit(PAGE);
    if (jump.fileId) {
      setOpen((current) => new Set(current).add(jump.fileId));
      requestAnimationFrame(() => document.getElementById(`file-${jump.fileId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    }
  }, [jump]);

  const visible = useMemo(() => filterFiles(rows, filters), [rows, filters]);
  const statusCounts = useMemo(() => countBy(rows, 'status'), [rows]);
  const categoryCounts = useMemo(() => countBy(rows, 'category'), [rows]);
  const set = (patch) => {
    setFilters((current) => ({ ...current, ...patch }));
    setLimit(PAGE);
  };
  const toggle = (id) => setOpen((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const filtered = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS);

  return (
    <div className="stack">
      <div className="toolbar">
        <label className="field grow">
          <span>Search path or hash prefix</span>
          <input type="search" value={filters.query} onChange={(e) => set({ query: e.target.value })} placeholder="dist/, index.js, 9f2c…" autoComplete="off" spellCheck="false" />
        </label>
        <label className="field">
          <span>Difference</span>
          <select value={filters.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="all">All ({rows.length})</option>
            {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]} ({statusCounts.get(s) ?? 0})</option>)}
          </select>
        </label>
        <label className="field">
          <span>Explanation</span>
          <select value={filters.category} onChange={(e) => set({ category: e.target.value })}>
            <option value="all">All categories</option>
            {CATEGORY_ORDER.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]} ({categoryCounts.get(c) ?? 0})</option>)}
          </select>
        </label>
      </div>
      <div className="toolbar between">
        <div className="segmented" role="group" aria-label="Focus">
          {FOCUS.map(([value, label]) => (
            <button key={value} type="button" aria-pressed={filters.focus === value} onClick={() => set({ focus: value })}>{label}</button>
          ))}
        </div>
        <p className="fine" role="status" aria-live="polite">
          {visible.length} of {rows.length} file{rows.length === 1 ? '' : 's'}
          {filtered && <> · <button type="button" className="link" onClick={() => set(DEFAULT_FILTERS)}>Clear filters</button></>}
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="empty"><strong>This report lists no files.</strong><span className="muted">The package archive contained no regular files to compare.</span></div>
      ) : visible.length === 0 ? (
        <div className="empty"><strong>No files match.</strong><span className="muted">Change or clear the filters.</span></div>
      ) : (
        <ul className="filelist">
          {visible.slice(0, limit).map((row) => {
            const expanded = open.has(row.id);
            return (
              <li key={row.id} id={`file-${row.id}`} className={`file${row.unexplained ? ' is-unexplained' : ''}${expanded ? ' is-open' : ''}`}>
                <button type="button" className="file-head" aria-expanded={expanded} aria-controls={`detail-${row.id}`} onClick={() => toggle(row.id)}>
                  <span className="chev" aria-hidden="true"><Icon name="chevron" size={14} /></span>
                  <span className="file-path mono">{row.path}</span>
                  <span className="file-badges">
                    <Badge tone={STATUS_TONE[row.status]} variant="outline">{STATUS_LABELS[row.status]}</Badge>
                    <Badge tone={CATEGORY_TONE[row.explanation.category]} variant={row.unexplained ? 'solid' : 'outline'}>{CATEGORY_LABELS[row.explanation.category]}</Badge>
                    {row.findings.length > 0 && <Badge tone={SEVERITY_TONE[row.findings[0].severity]}>{row.findings.length} finding{row.findings.length === 1 ? '' : 's'}</Badge>}
                    {row.opinion && <Badge tone="ai" variant="outline" title="Local model opinion (advisory)">{AI_LABEL_TEXT[row.opinion.label]?.replace('Model: ', 'AI: ') ?? 'AI'}</Badge>}
                  </span>
                  <span className="file-meta mono muted">{formatBytes((row.package ?? row.source)?.size)} · {shortHash((row.package ?? row.source)?.sha256, 8)}</span>
                </button>
                {expanded && <FileDetail row={row} report={report} onOpenFinding={onOpenFinding} />}
              </li>
            );
          })}
        </ul>
      )}
      {visible.length > limit && (
        <button type="button" className="btn center" onClick={() => setLimit((n) => n + PAGE)}>Show {Math.min(PAGE, visible.length - limit)} more ({visible.length - limit} hidden)</button>
      )}
    </div>
  );
}
