# debug@4.4.1

**Input:** [`input.json`](input.json), the npm package `debug` at exact version `4.4.1`.

**Output:** [`report.json`](report.json) (full report) and [`report.txt`](report.txt)
(the text summary printed by the CLI).

```bash
node server/bin/audyssey.js analyze debug@4.4.1 --out "examples/debug@4.4.1/report.json" > "examples/debug@4.4.1/report.txt"
```

## What happened

- The tarball matched the checksum the registry publishes (`sha512`).
- npm recorded a `gitHead` for this release, and that exact commit
  (`33330fa8616b…`) in `debug-js/debug` was downloaded and used. Confidence is
  `exact-commit`.
- The source `package.json` has the same name and version as the package.
- 7 published files are byte-identical to the source. The 6 `source-only` files
  (`.editorconfig`, `.gitignore`, `.travis.yml`, `karma.conf.js`, `test.js`,
  `test.node.js`) are repository tooling and tests that are not published.
- `package.json` is identical, so `manifest.changes` is empty, and the package
  defines no install-time scripts.
- The scanner read 6 files and reported one finding, at `info` severity:
  `src/node.js` lists the environment (`Object.keys(process.env)`) to read the
  `DEBUG_*` options. The source has the same code, so it is listed with no
  severity and no points.
- Risk score 0, verdict `no-differences`: every published file matches the
  source, and nothing of low severity or above was found. That describes this
  comparison and this set of patterns; it is not a guarantee that the code is
  safe.
