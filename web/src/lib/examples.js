import debug from '../../../examples/debug@4.4.1/report.json' with { type: 'json' };
import mitt from '../../../examples/mitt@3.0.1/report.json' with { type: 'json' };
import tampered from '../../../examples/tampered-demo/report.json' with { type: 'json' };

// The committed examples are real output of the tool (never hand-written), so they
// are the only reports the dashboard can show without the user opening a file.
export const BUNDLED_REPORTS = [
  { id: 'debug', title: 'debug@4.4.1', note: 'Published straight from source', report: debug },
  { id: 'mitt', title: 'mitt@3.0.1', note: 'Build step, explained from source maps', report: mitt },
  { id: 'tampered', title: 'debug@4.4.1 (tampered copy)', note: 'Local tarball with an added install script', report: tampered },
];
