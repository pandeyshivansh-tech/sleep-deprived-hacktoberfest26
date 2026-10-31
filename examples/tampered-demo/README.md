# tampered-demo

A deliberately modified copy of the real `debug@4.4.1` tarball, to show what the
comparison surfaces when a published package no longer matches its source.

**This file is a demonstration made by this team.** It is not a real release,
and `debug` was not compromised. The added file is an inert placeholder that
does nothing.

**Input:** [`debug-4.4.1-tampered.tgz`](debug-4.4.1-tampered.tgz), referenced by
[`input.json`](input.json). It is built by [`make-tampered.py`](make-tampered.py),
which downloads the real tarball, checks it against the registry checksum, and
rewrites it in memory with three changes:

1. `package.json` gains `"postinstall": "node lib/telemetry.min.js"`
2. `src/node.js` gets one appended comment line
3. `lib/telemetry.min.js` is added (inert placeholder)

**Output:** [`report.json`](report.json) and [`report.txt`](report.txt).

```bash
python3 -I examples/tampered-demo/make-tampered.py
```

```bash
node server/bin/audyssey.js analyze --tarball examples/tampered-demo/debug-4.4.1-tampered.tgz --ai --out examples/tampered-demo/report.json > examples/tampered-demo/report.txt
```

## What Audyssey reported

- **Integrity not verified.** The tarball's checksum does not match the one the
  registry publishes for `debug@4.4.1` (`package.integrity.verified: false`, and
  an `integrity` entry in `errors`).
- `package.json` and `src/node.js` are `modified`. (The `src/node.js` change is one
  appended comment line; the scanner does not read it as a change in behavior.)
- `lib/telemetry.min.js` is `package-only`: it exists nowhere in the source.
- `manifest.changes` contains `scripts.postinstall` as `added`, and
  `manifest.installScripts.package` lists `postinstall`, which the source does
  not define.
- The package name and version were read from the tarball itself
  (`input.source: "tarball"`) and the source was found through the registry's
  recorded commit.

- The scanner reports four findings (the strongest first):
  `install-script-added` (high), `integrity-mismatch` (high, package scope),
  `install-script-runs-unsourced-file` (medium: `postinstall` runs
  `lib/telemetry.min.js`, which the source does not have) and an `info` entry for
  `src/node.js`, whose environment-listing code is also in the source.
- **Risk score 68, verdict `suspicious`.** The verdict needs two distinct strong
  rules, and here the added install script and the checksum mismatch are
  independent facts. `summary.scoring` in `report.json` shows how each finding
  contributes.

- **No evidence explains the changes.** `lib/telemetry.min.js`, `package.json` (it
  changes `scripts`) and `src/node.js` are `unexplained`; the other differences are
  repository files `package.json`'s `files` list leaves out (`not-published`).
  Nothing here can reach `expected-differences`.
- **Local models (real output, `--ai`):** `gemma4:e4b` classified the 3 files that
  differ (`lib/telemetry.min.js` as suspicious, the other two as needing
  investigation) and `deepseek-r1:8b` explained the three strongest findings in
  plain words, each with implications and what remains uncertain. They add
  explanations under `ai`; they did not change a finding, the score (68) or the
  verdict. The model said the added file was suspicious partly because its own
  comment says it simulates tampering, which is true of this demo file.

The added file is inert, so the scanner has nothing to say about its contents:
the `suspicious` verdict comes from how the package differs from its source and
from the published checksum, not from any behavior in the file.
