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
node server/bin/audyssey.js analyze --tarball examples/tampered-demo/debug-4.4.1-tampered.tgz --out examples/tampered-demo/report.json > examples/tampered-demo/report.txt
```

## What Audyssey reported

- **Integrity not verified.** The tarball's checksum does not match the one the
  registry publishes for `debug@4.4.1` (`package.integrity.verified: false`, and
  an `integrity` entry in `errors`).
- `package.json` and `src/node.js` are `modified`.
- `lib/telemetry.min.js` is `package-only`: it exists nowhere in the source.
- `manifest.changes` contains `scripts.postinstall` as `added`, and
  `manifest.installScripts.package` lists `postinstall`, which the source does
  not define.
- The package name and version were read from the tarball itself
  (`input.source: "tarball"`) and the source was found through the registry's
  recorded commit.

Audyssey does not yet decide that these differences are suspicious. It surfaces
them as evidence, and the verdict stays `inconclusive`.
