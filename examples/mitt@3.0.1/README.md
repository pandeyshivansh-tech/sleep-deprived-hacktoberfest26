# mitt@3.0.1

**Input:** [`input.json`](input.json), the npm package `mitt` at exact version `3.0.1`.

**Output:** [`report.json`](report.json) (full report) and [`report.txt`](report.txt)
(the text summary printed by the CLI).

```bash
node server/bin/audyssey.js analyze mitt@3.0.1 --out "examples/mitt@3.0.1/report.json" > "examples/mitt@3.0.1/report.txt"
```

## What happened

- The tarball matched the registry checksum, and the exact `gitHead` commit of
  `developit/mitt` was used as the source (`exact-commit`).
- 3 files are identical (`LICENSE`, `README.md`, `package.json`).
- 7 files are `package-only`: `dist/mitt.js`, `dist/mitt.mjs`, `dist/mitt.umd.js`,
  their source maps, and `index.d.ts`. These are what a build step produces, so
  they have no counterpart in the repository. Audyssey reports them as
  `unclassified`: it does not yet decide whether they are legitimate build
  output, and a generated file is never assumed to be safe.
- 9 files are `source-only`: `src/index.ts`, the tests, and repository tooling.

- The scanner read the published code and found nothing to report. Risk score 0.
- The verdict is `needs-review`, not `no-differences`: the build output differs
  from the source and nothing can explain it yet. Once the build-artifact
  explainer exists this package is the case it is meant to settle, by telling
  build output that traces back to `src/` from a file that has no business being
  there. Until then Audyssey does not call differences "expected".
