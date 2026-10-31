# mitt@3.0.1

**Input:** [`input.json`](input.json), the npm package `mitt` at exact version `3.0.1`.

**Output:** [`report.json`](report.json) (full report) and [`report.txt`](report.txt)
(the text summary printed by the CLI).

```bash
node server/bin/audyssey.js analyze mitt@3.0.1 --ai --out "examples/mitt@3.0.1/report.json" > "examples/mitt@3.0.1/report.txt"
```

## What happened

- The tarball matched the registry checksum, and the exact `gitHead` commit of
  `developit/mitt` was used as the source (`exact-commit`).
- 3 files are identical (`LICENSE`, `README.md`, `package.json`).
- 7 files are `package-only`: `dist/mitt.js`, `dist/mitt.mjs`, `dist/mitt.umd.js`,
  their source maps, and `index.d.ts`. These are what a build step produces, so
  they have no counterpart in the repository. The explainer
  judges them from evidence (below); a generated file is still scanned and never
  assumed to be safe.
- 9 files are `source-only`: `src/index.ts`, the tests, and repository tooling. The
  package's `files` list does not cover them, so they are `not-published`.

- The scanner read the published code and found nothing to report. Risk score 0.
- Run with `--ai`, **`gemma4:e4b` classified the 7 files that differ** (real
  output, in the `ai` section): all 7 as `expected-artifact` (CommonJS, ES module
  and UMD builds, their source maps, and the type declaration). There were no
  findings, so `deepseek-r1:8b` had nothing to investigate and was not called.
  This is advisory: it does not change the score or the verdict.
- **Explained from evidence, not by name.** Each `dist/*.map` is a version-3 source
  map whose embedded `sourcesContent` is byte-identical to `src/index.ts` in the
  repository. Each built file ends with a `sourceMappingURL` to its map, which
  describes all of its lines, and `package.json` declares it as an entry point
  (`main`, `module`, `exports`, ...). `index.d.ts` is the declared `types` entry,
  contains only declarations and has the same-named source `src/index.ts`
  (medium confidence). `package.json` differs only by added publish metadata.
- The verdict is `expected-differences`: every difference is explained, the
  scanner found nothing, and the score is 0. It is not a statement that the
  package is safe: a map shows the files claim this source, not that they equal
  real compiler output.
