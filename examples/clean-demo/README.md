# clean-demo — Example A: a clean package

**Input:** [`debug-4.4.1.tgz`](debug-4.4.1.tgz) (13 kB), the real `debug@4.4.1` tarball
exactly as the npm registry serves it (MIT-licensed). Its SHA-512 matches the
checksum npm publishes for that version, which is how the analysis confirms it.
The input is referenced by [`input.json`](input.json).

**Output (captured from a real run):** [`report.json`](report.json) and
[`report.txt`](report.txt), written by the tool, never edited.

## Reproduce

Needs network access to `registry.npmjs.org` and `codeload.github.com` (the source
is looked up there). No Ollama is needed.

```bash
node server/bin/audyssey.js analyze --tarball examples/clean-demo/debug-4.4.1.tgz --out examples/clean-demo/report.json > examples/clean-demo/report.txt
```

Or upload `debug-4.4.1.tgz` in the dashboard. To fetch the same archive yourself:
`npm pack debug@4.4.1` (the file is byte-identical).

## Expected result

| | |
|---|---|
| Verdict | `no-differences` |
| Risk score | `0` |
| Integrity | verified against the registry checksum |
| Source | exact commit `33330fa8616b…` recorded by npm (`exact-commit`) |
| Files | 7 identical, 0 modified, 0 package-only (6 repository files are not published) |
| Findings | one `info` entry (`src/node.js` reads `process.env` to honour `DEBUG_*`; the source does the same, so it carries no points) |

This describes this comparison and this set of scanner patterns. It is not a
guarantee that the code is safe.

The report here has `input.source: "tarball"` because it was produced from the file,
the same path the dashboard upload takes. [`../debug@4.4.1`](../debug@4.4.1) holds the
same package analyzed by name from the registry.
