# Audyssey

**Know what you're actually installing.**

Audyssey compares a published npm package with the source repository it claims to
come from, explains each difference from evidence, and flags suspicious
modifications with quoted proof. Built by team **Sleep Deprived** (Akash Pansari,
Shivansh Pandey, Aman Mishra) for Hacktoberfest 2026 Hack Day Sonipat,
**Problem 04: Published Package vs Source Code Integrity Analyzer**.

## Quick start (about 2 minutes)

Needs Node.js 22.12+ and internet access (the source is looked up on GitHub). Ollama
is optional.

```bash
npm ci
```

```bash
npm run dev:server
```

In a second terminal:

```bash
npm run dev:web
```

Open **http://127.0.0.1:5173**, drop `examples/clean-demo/debug-4.4.1.tgz` (clean) or
`examples/tampered-demo/debug-4.4.1-tampered.tgz` (tampered) onto **Analyze a package**,
and click **Analyze**. A guided 2–3 minute walkthrough is in [`docs/DEMO.md`](docs/DEMO.md).

## The problem

An npm package is a tarball someone uploaded. Nothing guarantees it was built from
the public repository it links to: a compromised maintainer account or build
pipeline can publish files, or an install script, that exist nowhere in the source.
Reviewing the repository tells you nothing about what you actually install.
Audyssey looks at the published bytes and checks them against the source.

## What Audyssey does

1. Fetches package metadata and checks the tarball against the registry's checksum.
2. Finds the source on GitHub (the exact commit npm recorded, else a version tag) and
   confirms the source `package.json` names the same package. If no source can be
   established the result is `inconclusive`, never clean.
3. Hashes every file (SHA-256) and classifies it as identical, modified, package-only
   or source-only; compares `package.json` field by field.
4. Scans the published files for risky patterns and scores them.
5. Explains each difference from evidence, or marks it `unexplained`.
6. Optionally asks two local models to interpret the result (advisory only).
7. Writes a JSON report ([contract](docs/report-schema.md)) shown in a dashboard.

## Key capabilities

| Capability | Detail |
|---|---|
| Integrity | Tarball checked against the registry checksum; package identity checked against the source `package.json`. |
| Package vs source | Exact-commit or tag resolution, monorepo subdirectories, per-file SHA-256 comparison. |
| Deterministic scanner | 22 rule ids: install scripts and the files they run, dynamic and decoded execution, process execution, credentials plus network, obfuscation, hooks near wallet code, hard-coded endpoints, native binaries, links leaving the package, text aimed at AI models, checksum/identity mismatch. Every finding quotes file, line and snippet. See [`docs/risk-model.md`](docs/risk-model.md). |
| Risk model | A documented score (0–100) with a per-finding breakdown, and a verdict decision table. One indicator alone never makes a package `suspicious`. |
| Build-artifact explainer | A difference is explained only by evidence: a source map whose embedded source is byte-identical to repository files, a generated file fully described by such a map, a declarations-only `types` entry with matching source, additive publish metadata, or files a literal `files` list leaves out. No file-name allowlist, and explained files are still scanned. |
| Local AI (optional) | `gemma4:e4b` classifies differences and `deepseek-r1:8b` explains the strongest findings, through your local Ollama only. |
| Dashboard | Upload a `.tgz` and watch real job state, then explore the overview, file comparison, findings and local-AI output. Also opens a `report.json` or a bundled example. |

## Architecture and data flow

```
   .tgz upload (dashboard) ──► POST /api/analyze ──► in-memory job
   name@version / --tarball (CLI) ──────────────────────┐        │
                                                        ▼        ▼
 npm registry ─► metadata + checksum        analyzeNpmPackage()  (server/src/analyze.js)
 GitHub       ─► source snapshot (gitHead, then tag)   │
                                                        ├─ bounded in-memory tar.gz reader (never extracted to disk)
                                                        ├─ SHA-256 inventory, file diff, package.json diff
                                                        ├─ explainer   (evidence for each difference)
                                                        ├─ scanner     (patterns in text, score, verdict)
                                                        └─ report v0.3.0 ── validateReport()
                                                                 │
                       optional --ai / "Also interpret…" ──► local Ollama: gemma4:e4b, then deepseek-r1:8b
                                                                 │  (writes only under `ai`; checked unchanged elsewhere)
                                                                 ▼
                                  CLI text/JSON  ·  GET /api/jobs/:id/report  ·  dashboard views
```

The CLI and the API run the same pipeline. The dashboard validates every report
against the same contract (`server/src/report/schema.js`) before showing it.

## Prerequisites and installation

- Node.js **22.12 or newer** (CI uses Node 24, see `.nvmrc`) and npm.
- Internet access to `registry.npmjs.org`, `codeload.github.com` and `github.com` for
  analyses. Tests and the example *rejections* need none.
- Optional: [Ollama](https://ollama.com) with both models (below).

```bash
npm ci
```

(`npm install` works too.)

## Run the backend and frontend

```bash
npm run dev:server    # API on http://127.0.0.1:8787 (restarts on change)
```

```bash
npm run dev:web       # dashboard on http://127.0.0.1:5173, proxies /api to 8787
```

```bash
curl http://127.0.0.1:8787/api/health
```

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8787` | API port |
| `HOST` | `127.0.0.1` | Bind address. There is no authentication; keep it local. |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Must be loopback; remote hosts are rejected. |

No API keys or secrets are needed. `npm start` runs only the API (no static dashboard);
the dashboard is run with `npm run dev:web`.

## Run a CLI analysis

```bash
npm run analyze -- debug@4.4.1
```

```bash
npm run analyze -- --tarball examples/tampered-demo/debug-4.4.1-tampered.tgz
```

| Option | Effect |
|---|---|
| `--json` | Print the full JSON report instead of the text summary |
| `--out <file>` | Also write the JSON report |
| `--ai` | Add local-model interpretation (needs Ollama, see below) |
| `--tarball <file.tgz>` | Analyze a local archive instead of downloading it; registry metadata and source are still looked up |

The version must be exact (`name@1.2.3`, `@scope/name@1.2.3`). Exit codes: `0` report
produced (even if `inconclusive`), `1` analysis failed (for example a network error),
`2` invalid input.

## Watch a package for new releases

```bash
npm run watch -- debug --since 4.4.1 --once
```

`watch` polls the npm registry's `latest` version of one package and, when a version
newer than the baseline appears, runs the normal analysis on it and prints the standard
report (add `--json` for the JSON report, `--ai` for local models). Without `--since`
the baseline is whatever is latest when you start. Each version is analyzed once per
session; a failed analysis or registry check is reported and retried at the next poll.
Options: `--interval <seconds>` (60 to 86400, default 300), `--once` (check once and
exit), `Ctrl-C` for a clean stop. Limits: it needs internet access, remembers nothing
after it exits, and only follows the registry's `latest` tag (so a new prerelease on
another tag is not seen). The CLI command is `node server/bin/audyssey.js watch <name>`.

## Upload a `.tgz` in the dashboard

1. Start the server and dashboard (above) and open http://127.0.0.1:5173.
2. In **Analyze a package (.tgz)** choose or drop an npm package archive, for example
   the output of `npm pack debug@4.4.1`. The name and size are shown first.
3. Click **Analyze**. The page shows the job's real state (`queued`, `running`,
   `completed`, `failed`) and the pipeline's actual steps.
4. The report opens in Overview, Files, Findings and Local AI, marked **Fresh analysis**.

Limits and behavior:
- **25 MB** compressed upload, enforced while the body is read (`413` beyond it). Only
  gzip-style content types are accepted and the body must start with the gzip
  signature (`400 not-gzip` otherwise).
- The archive is parsed by the same bounded reader as the CLI. Per archive: 50 MB
  compressed, 250 MB uncompressed, 20,000 entries, 50 MB per file, path length 1024 and
  depth 40, compression ratio 200 (checked above 1 MB). Exceeding one is an error, never
  a silent truncation. Traversal, absolute paths, duplicate paths, devices and trailing
  data are rejected; symlinks and hardlinks are recorded and never followed.
- Jobs live **in memory only**. They disappear when the server restarts or after one
  hour. One analysis runs at a time and two may wait; beyond that the server answers
  `429`. There is no authentication, no persistence and no way to cancel a running job
  (the page can only stop watching).
- The server needs internet access for the registry and GitHub lookups. A package the
  registry does not know cannot be compared, and there is no offline analysis mode.

API summary: `POST /api/analyze` (raw `.tgz` body, `Content-Type: application/gzip`,
optional `?ai=1&filename=…`), `GET /api/jobs/:id`, `GET /api/jobs/:id/report`,
`GET /api/health`. Details are in [`CLAUDE.md`](CLAUDE.md).

## Configure and run the local Ollama models

AI is optional and advisory. Install Ollama, then:

```bash
ollama pull gemma4:e4b
```

```bash
ollama pull deepseek-r1:8b
```

```bash
npm run analyze -- --tarball examples/tampered-demo/debug-4.4.1-tampered.tgz --ai
```

In the dashboard tick **Also interpret with the local models** (it is disabled until
`/api/health` reports both models installed). The models run one after the other, each
unloaded after use, and only when there is something to interpret. Expect roughly 15
seconds for classification and 1–3 minutes for the reasoning model on a laptop; the
timings in [`docs/ai-analysis.md`](docs/ai-analysis.md) were measured locally.

- Inference goes only to the local Ollama. There is no cloud model, SDK or fallback.
- The models cannot add, remove or change a finding, severity, hash, score or verdict.
  The report is checked unchanged outside `ai` afterwards; model output that refers to
  unknown files or findings is dropped, and a file the scanner flagged cannot be cleared
  as an expected artifact.
- If Ollama or a model is missing, the deterministic analysis still completes and
  `ai.status` says so. Models can be wrong.

## Run tests and build

```bash
npm test
```

```bash
npm run build
```

Tests use Node's built-in runner and never touch the network, Ollama or model
downloads: registry, GitHub and Ollama are faked, and hostile archives (traversal,
links, bombs, corrupt headers) are built inside the tests. CI runs `npm ci`, `npm test`
and `npm run build` on every pull request.

## Reproduce the examples

Every report in [`examples/`](examples) is real tool output, never edited. Each folder
has its input and exact commands; [`examples/README.md`](examples/README.md) is the index.

| Example | Input | Command | Expected |
|---|---|---|---|
| **A. Clean** ([`clean-demo`](examples/clean-demo)) | real `debug@4.4.1` tarball | `npm run analyze -- --tarball examples/clean-demo/debug-4.4.1.tgz` | `no-differences`, score 0 |
| **B. Tampered** ([`tampered-demo`](examples/tampered-demo)) | `debug@4.4.1` plus an added `postinstall` and an added inert file | `npm run analyze -- --tarball examples/tampered-demo/debug-4.4.1-tampered.tgz` | `suspicious`, score 68; checksum mismatch, `install-script-added`, `install-script-runs-unsourced-file` |
| **C. Invalid** ([`invalid-demo`](examples/invalid-demo)) | text named `.tgz`; gzip that is not a tar | `npm run analyze -- --tarball examples/invalid-demo/not-a-gzip.tgz` | exit code 2 with "Archive is not gzip-compressed"; the API answers `400 not-gzip` |

A and B need internet for the source lookup; C needs none. More: `mitt@3.0.1` is a
built package (`expected-differences`, every build file explained by source maps) and
`debug@4.4.1` is analyzed by name. The tampered fixture is rebuilt with
`python3 -I examples/tampered-demo/make-tampered.py` (harmless: the added file is an
inert placeholder).

## Verdicts and the risk score

| Verdict | Meaning |
|---|---|
| `no-differences` | Source resolved, every published file matches it, nothing of low severity or above found. |
| `expected-differences` | Every difference is explained from evidence, and nothing of low severity or above was found. |
| `needs-review` | A finding of low severity or above, or differences no evidence explains. A prompt to look, not an accusation. |
| `suspicious` | At least two distinct rules produced high or critical findings and the score is at least 60. |
| `inconclusive` | The source could not be resolved or the package could not be assessed. Never a clean result. |

The score is a transparent sum of finding weights (adjusted for confidence, whether the
behavior is new in the package, and repeats), capped at 100, with the per-finding
breakdown in the report so it can be recomputed. The exact table and the reasons for each
weight are in [`docs/risk-model.md`](docs/risk-model.md). Findings say what code attempts
("attempts to", "appears to"), not that it is malicious.

## Security model

- Packages, source files, metadata and model output are untrusted.
- Package code is **never executed, imported, installed or built**, and lifecycle scripts
  never run. The scanner only matches text.
- Archives are read **in memory** under hard limits and are never extracted to disk; links
  are recorded and not followed. Uploaded bytes are held in memory only until the
  analysis ends.
- Network access only to the npm registry, GitHub and the local Ollama, through a host
  allowlist with re-checked redirects. No endpoint accepts a filesystem path, URL or
  command.
- Errors sent to clients are bounded and never include stack traces or local paths.
- The dashboard renders package content as text only.
- Model output stays under `ai`, is advisory, and never overrides deterministic results.

**Non-goals:** Audyssey is not an antivirus or a sandbox, does not detect all
supply-chain attacks, and does not guarantee that a package is safe.

## Current limitations

- npm packages with GitHub-hosted source only. No PyPI, other registries or non-GitHub
  hosts. npm provenance attestations are reported when present but not verified.
- The scanner is heuristic: it can miss obfuscated or dynamically built code and files
  over its size limit, and can match code that never runs. A low score or an empty
  findings list is never a statement of safety. On a corpus of 24 popular packages it
  reported no high or critical finding ([details](docs/risk-model.md)).
- The explainer does not read bundler or `tsconfig` configuration, and a valid source map
  does not prove a file equals real compiler output.
- Analysis needs internet access. Jobs are in memory (one hour), with no authentication,
  persistence or cancellation. Analysis by package name is CLI only.
- Local models can be wrong and are slow on modest hardware.
- Release watch is a foreground CLI loop: it polls one package, keeps no state across restarts, sends no notifications and has no dashboard view.

## Project structure

```
server/     Express API, analysis pipeline (archive, compare, explain, scan, report, ai) and CLI
web/        React + Vite dashboard (components, pure view logic in web/src/lib)
docs/       Report contract, risk model, AI analysis, demo guide
examples/   Real inputs and outputs (clean-demo, tampered-demo, invalid-demo, mitt, debug)
.github/    CI workflow and pull request template
```

Further reading: [`docs/report-schema.md`](docs/report-schema.md),
[`docs/risk-model.md`](docs/risk-model.md), [`docs/ai-analysis.md`](docs/ai-analysis.md),
[`docs/DEMO.md`](docs/DEMO.md), [`CLAUDE.md`](CLAUDE.md) (engineering notes).

## AI-assisted development

Claude Code was used as a development assistant to help write this repository, and each
pull request discloses it. It is not part of the product: Audyssey uses only the local
models above.

## License

[MIT](LICENSE)
