# Examples

Real inputs and the **actual outputs** produced by Audyssey. `report.json` and
`report.txt` in each example are written by the tool and never edited by hand.
Every `report.json` follows the [report contract](../docs/report-schema.md).

| Example | Input | What it shows |
|---|---|---|
| [`debug@4.4.1`](debug@4.4.1) | npm registry | A package published straight from source: every published file matches the source, nothing was flagged, and the verdict is `no-differences` |
| [`mitt@3.0.1`](mitt@3.0.1) | npm registry | A package with a build step: `dist/` exists only in the published package. The scanner finds nothing and every build file is explained from evidence (source maps whose embedded source matches `src/index.ts`, entry points, a declarations-only types file), so the verdict is `expected-differences` with a score of 0 |
| [`tampered-demo`](tampered-demo) | local `.tgz` | A deliberately modified copy of `debug@4.4.1`: checksum mismatch, an added install script that runs an added file. Two distinct strong rules make it `suspicious` (68/100); the three differing files have no evidence and are `unexplained` |

## What these examples show, and what they do not

Audyssey retrieves the package and the matching source, compares every file by
SHA-256, compares `package.json`, checks the registry checksum, and runs a
deterministic scanner over the published files (see
[`docs/risk-model.md`](../docs/risk-model.md)). It produces a risk score with a
per-finding breakdown and a verdict.

The `mitt` and `tampered-demo` examples were also run with `--ai`: **real output
of the two local models** (`gemma4:e4b` classified the files that differ, and for
the tampered copy `deepseek-r1:8b` explained the strongest findings). That output
is under `ai` in each `report.json` and `report.txt`, with the model digests and
durations. It is advisory: the findings, score and verdict above it come only
from the deterministic scanner, and a model's text is not a finding. Model output
varies a little between runs; the rest of each report does not. `debug@4.4.1`
matches its source, so there was nothing to interpret and no model was called.

The explainer decides from evidence whether a difference is a normal build
artifact (see [`docs/risk-model.md`](../docs/risk-model.md#explaining-differences)).
It has no list of file names, a forged source map is not evidence, and an
explained file is still scanned. A model's opinion is not an explanation: Gemma's
label never changes a category or the verdict.

The scanner matches patterns in text. It can miss obfuscated or dynamically built
code and can match code that never runs, so a low score is not a statement that
a package is safe.

## Reproducing

From the repository root, after `npm install`. The `--ai` commands also need Ollama
running with `gemma4:e4b` and `deepseek-r1:8b` pulled, and take up to a few minutes. Registry examples need network
access to `registry.npmjs.org` and `codeload.github.com`; published npm
versions are immutable, so the results are the same except for `generatedAt`.

```bash
node server/bin/audyssey.js analyze debug@4.4.1 --out "examples/debug@4.4.1/report.json" > "examples/debug@4.4.1/report.txt"
```

```bash
node server/bin/audyssey.js analyze mitt@3.0.1 --ai --out "examples/mitt@3.0.1/report.json" > "examples/mitt@3.0.1/report.txt"
```

```bash
node server/bin/audyssey.js analyze --tarball examples/tampered-demo/debug-4.4.1-tampered.tgz --ai --out examples/tampered-demo/report.json > examples/tampered-demo/report.txt
```

The illustrative sample in [`docs/report.sample.json`](../docs/report.sample.json)
describes a fictional package to document the report format. It is not an
example output.
