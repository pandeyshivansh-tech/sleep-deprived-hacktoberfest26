import { useEffect, useRef, useState } from 'react';
import { animate, motion, useInView } from 'motion/react';
import { BUNDLED_REPORTS } from '../lib/examples.js';
import { PIPELINE, findingExample, parityRows, parityStats } from '../lib/landing.js';
import { describeVerdict } from '../lib/report-view.js';
import { Badge } from './ui.jsx';

const EASE = [0.22, 1, 0.36, 1];
const reveal = {
  hidden: { opacity: 0, y: 14 },
  show: (i = 0) => ({ opacity: 1, y: 0, transition: { duration: 0.55, ease: EASE, delay: i * 0.07 } }),
};
const inView = { initial: 'hidden', whileInView: 'show', viewport: { once: true, margin: '-60px' } };

function CountUp({ value }) {
  const ref = useRef(null);
  const seen = useInView(ref, { once: true });
  useEffect(() => {
    if (!seen || !ref.current) return undefined;
    const controls = animate(0, value, { duration: 1.1, ease: EASE, onUpdate: (n) => { if (ref.current) ref.current.textContent = Math.round(n); } });
    return () => controls.stop();
  }, [seen, value]);
  return <span ref={ref}>{value}</span>;
}

const SIDE_NOTE = {
  identical: 'matches source',
  modified: 'differs from source',
  'package-only': 'not in the source',
};

function ParityMap() {
  const choices = [
    ['debug', 'Published straight from source', BUNDLED_REPORTS.find((e) => e.id === 'debug')],
    ['tampered', 'Tampered copy', BUNDLED_REPORTS.find((e) => e.id === 'tampered')],
  ];
  const [which, setWhich] = useState('tampered');
  const entry = choices.find(([id]) => id === which)[2];
  const { rows, total } = parityRows(entry.report);
  const stats = parityStats(entry.report);
  const verdict = describeVerdict(stats.verdict);

  return (
    <motion.section className="parity" variants={reveal} {...inView} aria-labelledby="parity-title">
      <header className="parity-head">
        <div>
          <p className="eyebrow">Provenance parity map</p>
          <h2 id="parity-title" className="mono parity-title">{entry.report.package.name}@{entry.report.package.version}</h2>
        </div>
        <div className="segmented" role="group" aria-label="Which published copy">
          {choices.map(([id, label]) => (
            <button key={id} type="button" aria-pressed={which === id} onClick={() => setWhich(id)}>{label}</button>
          ))}
        </div>
      </header>

      <p className="parity-source mono">
        <span className="muted">REAL REPORT</span> examples/{which === 'debug' ? 'debug@4.4.1' : 'tampered-demo'}/report.json · source{' '}
        <span className="copper">{entry.report.source.repository?.replace('https://', '')}</span> @ {entry.report.source.ref.commit?.slice(0, 7)}
      </p>

      <div className="parity-grid" role="table" aria-label="Published files compared with the source">
        <div className="parity-cols mono" role="row">
          <span role="columnheader">Published file</span>
          <span role="columnheader" className="hash-col">Source sha256</span>
          <span role="columnheader" className="hash-col">Package sha256</span>
          <span role="columnheader" className="note-col">Result</span>
        </div>
        {rows.map((row, i) => (
          <motion.div
            key={`${which}-${row.id}`}
            role="row"
            className={`parity-row tone-row-${row.tone}`}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.4, ease: EASE, delay: 0.06 * i }}
          >
            <span className="parity-path mono" role="cell"><span className={`glyph tone-${row.tone}`} aria-hidden="true">{row.glyph}</span>{row.path}</span>
            <span className="mono hash-col" role="cell">{row.sourceHash ?? '—'}</span>
            <span className="mono hash-col" role="cell">{row.packageHash ?? '—'}</span>
            <span className={`note-col fine tone-${row.tone === 'ok' ? 'ok' : 'danger'}`} role="cell">{SIDE_NOTE[row.status]}{row.explained ? ' · explained' : ''}</span>
          </motion.div>
        ))}
        {total > rows.length && <p className="fine muted parity-more">+ {total - rows.length} more published files, all matching</p>}
      </div>

      <dl className="parity-stats">
        <div><dt>Differing files</dt><dd className="mono"><CountUp key={`d-${which}`} value={stats.differing} /></dd></div>
        <div><dt>Findings</dt><dd className="mono"><CountUp key={`f-${which}`} value={stats.findings} /></dd></div>
        <div><dt>Risk score</dt><dd className="mono"><CountUp key={`s-${which}`} value={stats.score} /><span className="muted"> / 100</span></dd></div>
        <div><dt>Verdict</dt><dd><Badge tone={verdict.tone}>{verdict.label}</Badge></dd></div>
      </dl>
      <p className="fine muted">A clean result describes this comparison and these scanner patterns. It is not a guarantee that a package is safe.</p>
    </motion.section>
  );
}

function Discrepancy() {
  const tampered = BUNDLED_REPORTS.find((e) => e.id === 'tampered').report;
  const mitt = BUNDLED_REPORTS.find((e) => e.id === 'mitt').report;
  const cards = [
    { tag: 'Install hook the source does not have', ex: findingExample(tampered, 'install-script-added') },
    { tag: 'Tarball is not the published release', ex: findingExample(tampered, 'integrity-mismatch') },
    { tag: 'Hook runs a file the source lacks', ex: findingExample(tampered, 'install-script-runs-unsourced-file') },
  ];
  const map = mitt.files.find((f) => f.path === 'dist/mitt.js');
  return (
    <section className="land-section" aria-labelledby="gap-title">
      <motion.div variants={reveal} {...inView}>
        <p className="eyebrow">01 · The gap</p>
        <h2 id="gap-title" className="land-h2">Reviewers read the repository. Installs run the tarball.</h2>
        <p className="land-lede">An npm package is an archive someone uploaded. Nothing guarantees it was built from the public source it links to. Audyssey compares the two and shows its evidence.</p>
      </motion.div>
      <div className="cards-3">
        {cards.map(({ tag, ex }, i) => ex && (
          <motion.article key={ex.ruleId} className="evid-card" variants={reveal} custom={i} {...inView}>
            <p className="eyebrow">{tag}</p>
            <h3 className="mono evid-rule">{ex.ruleId} <Badge tone={ex.severity === 'medium' ? 'warn' : 'danger'}>{ex.severity}</Badge></h3>
            <p className="fine">{ex.title}</p>
            {ex.snippet ? <pre className="evid-snippet"><code>{ex.location && <span className="muted">{ex.location}{'\n'}</span>}{ex.snippet}</code></pre> : <p className="fine muted">Package-wide finding: the bytes analysed do not match the registry checksum.</p>}
          </motion.article>
        ))}
      </div>
      <motion.aside className="benign" variants={reveal} {...inView}>
        <Badge tone="info" variant="outline">Different is not the same as bad</Badge>
        <p><span className="mono">{map.path}</span> exists only in the published package, as it does for any build step. Audyssey explains it from evidence: <span className="evid-line">{map.explanation.evidence.find((e) => /byte-identical/.test(e))}</span> It is still scanned.</p>
      </motion.aside>
    </section>
  );
}

function Pipeline() {
  return (
    <section className="land-section" aria-labelledby="pipe-title">
      <motion.div variants={reveal} {...inView}>
        <p className="eyebrow">02 · Pipeline</p>
        <h2 id="pipe-title" className="land-h2">From registry byte to evidence.</h2>
      </motion.div>
      <ol className="pipeline">
        {PIPELINE.map((stage, i) => (
          <motion.li key={stage.id} variants={reveal} custom={i} {...inView}>
            <span className="stage-n mono">{String(i + 1).padStart(2, '0')}</span>
            <h3>{stage.title}</h3>
            <p className="fine">{stage.text}</p>
          </motion.li>
        ))}
      </ol>
    </section>
  );
}

function Boundary({ onStart }) {
  const items = [
    ['Never executed', 'Package code, install scripts and build steps are not run, imported or installed. The scanner only matches text.'],
    ['In memory only', 'Archives are read under hard limits and never extracted to disk. Uploads are kept in memory until the analysis ends.'],
    ['AI is advisory', 'Two local models through Ollama (gemma4:e4b, deepseek-r1:8b) add explanations beside the findings. They cannot change a finding, the score or the verdict.'],
  ];
  return (
    <section className="land-section" aria-labelledby="bound-title">
      <motion.div variants={reveal} {...inView}>
        <p className="eyebrow">03 · Security boundary</p>
        <h2 id="bound-title" className="land-h2">Deterministic evidence is the source of truth.</h2>
      </motion.div>
      <div className="cards-3">
        {items.map(([title, text], i) => (
          <motion.article key={title} className="evid-card" variants={reveal} custom={i} {...inView}>
            <h3>{title}</h3>
            <p className="fine">{text}</p>
          </motion.article>
        ))}
      </div>
      <motion.div className="cta" variants={reveal} {...inView}>
        <div>
          <h2 className="land-h2 small">Try it on a package.</h2>
          <p className="fine">Upload an npm <span className="mono">.tgz</span>, or open a bundled report. Analysis needs internet access for the source lookup.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={onStart}>Analyze a package</button>
      </motion.div>
    </section>
  );
}

export default function Landing({ onStart }) {
  return (
    <div className="landing">
      <div className="ticker mono" aria-hidden="true">
        <span>ZERO-EXECUTION</span><span>ARCHIVES READ IN MEMORY</span><span>REGISTRY + GITHUB ONLY</span><span>LOCAL OLLAMA ONLY</span>
      </div>
      <section className="hero-land" aria-labelledby="hero-title">
        <motion.img className="hero-logo" src="/audyssey-logo.svg" width="320" height="320" alt="" aria-hidden="true" initial={{ opacity: 0, scale: 0.94, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: 1, ease: EASE, delay: 0.2 }} />
        <div className="hero-copy">
          <motion.p className="eyebrow copper" variants={reveal} initial="hidden" animate="show">Published package vs source integrity</motion.p>
          <h1 id="hero-title" className="hero-h1">
            {['Know what you’re', 'actually installing.'].map((line, i) => (
              <span className="line" key={line}>
                <motion.span className={i === 1 ? 'copper' : undefined} initial={{ y: '105%' }} animate={{ y: 0 }} transition={{ duration: 0.8, ease: EASE, delay: 0.1 + i * 0.12 }}>{line}</motion.span>
              </span>
            ))}
          </h1>
          <motion.p className="hero-sub" variants={reveal} custom={4} initial="hidden" animate="show">
            Audyssey compares a published npm package with the source repository it claims to come from, explains each difference from evidence, and flags suspicious changes with quoted proof.
          </motion.p>
          <motion.div className="inline" variants={reveal} custom={5} initial="hidden" animate="show">
            <button type="button" className="btn btn-primary" onClick={onStart}>Analyze a package</button>
            <span className="fine muted mono">no package code is ever executed</span>
          </motion.div>
        </div>
      </section>
      <ParityMap />
      <Discrepancy />
      <Pipeline />
      <Boundary onStart={onStart} />
      <footer className="land-footer">
        <img src="/audyssey-logo.svg" width="56" height="56" alt="" aria-hidden="true" />
        <p className="footer-name" aria-label="Audyssey">Audyssey</p>
        <p className="fine muted">Know what you’re actually installing. Built by team Sleep Deprived for Hacktoberfest 2026 Hack Day Sonipat.</p>
      </footer>
    </div>
  );
}
