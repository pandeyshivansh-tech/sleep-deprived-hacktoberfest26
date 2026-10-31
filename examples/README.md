# Examples

Real inputs and the **actual outputs** produced by Audyssey. `report.json` and
`report.txt` in each example are written by the tool and never edited by hand.
Every `report.json` follows the [report contract](../docs/report-schema.md).

| Example | Input | What it shows |
|---|---|---|
| [`debug@4.4.1`](debug@4.4.1) | npm registry | A package published straight from source: the published files are identical to the source, and the only differences are tests and tooling that were never published |
| [`mitt@3.0.1`](mitt@3.0.1) | npm registry | A package with a build step: `dist/` and `index.d.ts` exist only in the published package, and `src/` and tests only in the source |
| [`tampered-demo`](tampered-demo) | local `.tgz` | A deliberately modified copy of `debug@4.4.1`: checksum mismatch, an added install script, an added file, a modified file |

## What these examples do and do not show

Audyssey currently does deterministic comparison only: it retrieves the package
and the matching source, compares every file by SHA-256, compares `package.json`
field by field, and reports provenance and integrity. It does **not** yet
explain whether a difference is a normal build artifact or suspicious, scan code
for risky behavior, or call the AI models. Accordingly, every report has:

- `scan.performed: false`, `summary.verdict: "inconclusive"` and
  `summary.riskScore: null` (no security assessment was performed)
- `explanation.category: "unclassified"` for each difference
- `ai.status: "skipped"` (no model was used)

The reports are the unmodified evidence that later analysis will build on.

## Reproducing

From the repository root, after `npm install`. Registry examples need network
access to `registry.npmjs.org` and `codeload.github.com`; published npm
versions are immutable, so the results are the same except for `generatedAt`.

```bash
node server/bin/audyssey.js analyze debug@4.4.1 --out "examples/debug@4.4.1/report.json" > "examples/debug@4.4.1/report.txt"
```

```bash
node server/bin/audyssey.js analyze mitt@3.0.1 --out "examples/mitt@3.0.1/report.json" > "examples/mitt@3.0.1/report.txt"
```

```bash
node server/bin/audyssey.js analyze --tarball examples/tampered-demo/debug-4.4.1-tampered.tgz --out examples/tampered-demo/report.json > examples/tampered-demo/report.txt
```

The illustrative sample in [`docs/report.sample.json`](../docs/report.sample.json)
describes a fictional package to document the report format. It is not an
example output.
