# Examples

Real inputs and the **actual outputs** produced by Audyssey. `report.json` and
`report.txt` in each example are written by the tool and never edited by hand.
Every `report.json` follows the [report contract](../docs/report-schema.md).

| Example | Input | What it shows |
|---|---|---|
| [`debug@4.4.1`](debug@4.4.1) | npm registry | A package published straight from source: every published file matches the source, nothing was flagged, and the verdict is `no-differences` |
| [`mitt@3.0.1`](mitt@3.0.1) | npm registry | A package with a build step: `dist/` exists only in the published package. The scanner finds nothing, but the build output is unexplained, so the verdict is `needs-review` with a score of 0 |
| [`tampered-demo`](tampered-demo) | local `.tgz` | A deliberately modified copy of `debug@4.4.1`: checksum mismatch, an added install script that runs an added file. Two distinct strong rules make it `suspicious` (68/100) |

## What these examples show, and what they do not

Audyssey retrieves the package and the matching source, compares every file by
SHA-256, compares `package.json`, checks the registry checksum, and runs a
deterministic scanner over the published files (see
[`docs/risk-model.md`](../docs/risk-model.md)). It produces a risk score with a
per-finding breakdown and a verdict. It does **not** yet:

- explain whether a difference is a normal build artifact, so every difference is
  `unclassified` and a package with differences is `needs-review` at best;
- call the AI models (`ai.status` is `skipped` in every report).

The scanner matches patterns in text. It can miss obfuscated or dynamically built
code and can match code that never runs, so a low score is not a statement that
a package is safe.

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
