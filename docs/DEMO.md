# Live demo guide (2–3 minutes)

Everything below was run against the current code. Timings are measured on the team's
laptop; yours will differ.

## Before you go on stage (5 minutes, with internet)

Analyses look up the source on `registry.npmjs.org` and `codeload.github.com`, so a
live upload **needs internet**. There is no offline analysis mode. Prepare so that a
bad network cannot stop the demo:

```bash
npm ci
```

```bash
npm run dev
```

1. Open http://127.0.0.1:5173. The **System** panel (bottom left) should show the API
   server running. If Ollama is up it shows both models installed.
2. Run both uploads once (steps 2 and 3 below). It confirms the network works and warms
   nothing you rely on later; it is a rehearsal, not a cache.
3. Optional AI: `ollama pull gemma4:e4b` and `ollama pull deepseek-r1:8b`, then Ollama
   running. Do not load other large models: the two models run one at a time but each
   needs several GB.
4. Keep these files handy: `examples/clean-demo/debug-4.4.1.tgz`,
   `examples/tampered-demo/debug-4.4.1-tampered.tgz`,
   `examples/invalid-demo/not-a-gzip.tgz`.

## Script

| Time | Say | Do |
|---|---|---|
| 0:00 | "An npm package is just a tarball someone uploaded. Nothing proves it matches the public repository it links to. Audyssey checks the published bytes against the source." | Show the dashboard workspace. |
| 0:15 | "Clean package first: the real `debug@4.4.1`." | Drop `debug-4.4.1.tgz` into **Analyze a package**, point at the filename and size, click **Analyze**. The page shows the real queued/running steps (about 5 seconds). |
| 0:35 | "Verdict: no differences, score 0. Checksum verified against the registry, source resolved to the exact commit npm recorded. Every published file matches the source. That is this comparison and these patterns, not a guarantee of safety." | Overview: verdict, integrity, source resolution, file counts. |
| 0:55 | "Now a tampered copy: same package, but someone added an install script and a file that is not in the source." | Workspace → drop `debug-4.4.1-tampered.tgz` → **Analyze** (about 5 seconds). |
| 1:10 | "Suspicious, 68 out of 100. The score is a sum of finding weights, and the breakdown is shown, so it can be recomputed." | Overview: verdict, score, **Score breakdown**. Note the topbar says **Fresh analysis**. |
| 1:25 | "Deterministic findings, each with quoted evidence: a `postinstall` the source does not have, a checksum that does not match what npm published, and the script runs a file the source does not contain." | **Findings**: open `install-script-added` and show `package.json:32` and the snippet. |
| 1:50 | "Unexplained files are marked. Nothing explains these from evidence, unlike a build output with a matching source map." | **Files** → **Unexplained**: `lib/telemetry.min.js`, `package.json`, `src/node.js`. |
| 2:05 | "Local AI is optional and advisory." | See "Showing the AI" below. |
| 2:25 | "Bad input is refused clearly." | Drop `not-a-gzip.tgz`: the server answers 400 "not a gzip-compressed archive". |
| 2:35 | "The key boundary: package code is never executed, installed or extracted to disk. Archives are read in memory under size, entry and ratio limits, and the scanner only matches text." | Say it; no demo needed. |
| 2:45 | "Limits: npm and GitHub only, a heuristic scanner, jobs kept in memory for an hour, no auth. Next: release monitoring." | Close. |

## Showing the AI

**Live (about 2–3 minutes, so only if you have time):** tick **Also interpret with the
local models** before **Analyze** on the tampered package. Gemma classifies the three
differing files (about 13 seconds) and DeepSeek explains the findings (about 2 minutes
on the team's laptop). Then open **Findings**: the dashed purple "Local model
explanation · advisory" box is separate from the deterministic finding above it, and
the **Local AI** page lists model names and digests.

**Recorded (recommended for a 3-minute slot):** **Workspace → Bundled example reports →
`debug@4.4.1 (tampered copy)`**. It is the real output of a previous `--ai` run
committed in `examples/tampered-demo/`, and the topbar labels it **Bundled example**, so
say that it is a recorded run rather than a live one.

Make the point that the findings, score and verdict are identical with or without the
models: the report is checked unchanged outside `ai`.

## Fallbacks

| Problem | What to do |
|---|---|
| Ollama not running or models missing | The **Also interpret…** box is disabled and says why. Run the demo without it and show the bundled tampered example for the AI view. If AI is requested while Ollama is down, the analysis still completes and the report says `ai.status: unavailable`. |
| No internet at the venue | Live uploads of A and B cannot work (source lookup). Use **Bundled example reports** (real recorded output, works offline once the dashboard is running) and say so plainly. The invalid-archive step still works offline because the archive is rejected before any lookup. |
| Server not running | The System panel shows it as unreachable and Analyze reports "Cannot reach the Audyssey server". Restart `npm run dev:server`. |
| Server restarted mid-demo | Jobs are in memory: the page reports the analysis is gone. Upload again. |
| Server busy (`429`) | One analysis runs at a time; wait a few seconds. |

## CLI alternative

```bash
npm run analyze -- --tarball examples/tampered-demo/debug-4.4.1-tampered.tgz
```

```bash
npm run analyze -- --tarball examples/invalid-demo/not-a-gzip.tgz
```

Reproduction details and expected results for each example are in
[`examples/README.md`](../examples/README.md).
