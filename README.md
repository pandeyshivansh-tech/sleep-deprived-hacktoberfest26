# Audyssey

**Know what you're actually installing.**

Audyssey compares a published npm package with the source repository it
claims to come from. It explains every difference, separates normal build
output from unexpected changes, and flags suspicious modifications with
evidence.

Built by team **Sleep Deprived** (Akash Pansari, Shivansh Pandey, Aman Mishra)
for Hacktoberfest 2026 Hack Day Sonipat, **Problem 04: Published Package vs
Source Code Integrity Analyzer**.

## Status

This repository is being built milestone by milestone through pull requests.

| Area | State |
|---|---|
| Repository foundation, CI, report contract | Done (M0) |
| API server with Ollama and model health check | Done (M0) |
| Dashboard showing server and model status | Done (M0) |
| npm retrieval, integrity check, source resolution, safe in-memory archive reading, SHA-256 file comparison, `package.json` comparison, command-line tool, real examples | Done (M1) |
| Deterministic security scanner, capability differential, documented risk score and verdict | Done (M2) |
| Build-artifact explainer (explaining why differences exist) | Implemented (M2b): source maps, `sourceMappingURL`, `types` entries, `files` lists; see [`docs/risk-model.md`](docs/risk-model.md#explaining-differences) |
| Gemma and DeepSeek analysis through local Ollama (`--ai`) | Done (M4) |
| Analysis dashboard, analysis API, local tarball upload in the UI | Planned (M3, M5) |
| Release monitoring | Planned (M6) |

This README describes only what exists, and each milestone PR updates it.

## What it does today

The command-line tool compares an npm package with its source repository:

1. Fetches the exact package version from the npm registry and verifies the
   tarball against the registry's published checksum.
2. Resolves the source snapshot on GitHub: the exact commit npm recorded
   (`gitHead`) when available, otherwise a tag named after the version, and
   reports how certain that match is. Monorepo subdirectories are supported.
   The source `package.json` must name the same package. If no source can be
   established, the result is `inconclusive` (or `needs-review` if the scan
   found something), never clean.
3. Reads both archives in memory, without executing package code, running
   install scripts or writing package contents to disk, and with limits on
   size, entry count, depth and compression ratio.
4. Hashes every file (SHA-256) and classifies it as identical, modified,
   package-only or source-only.
5. Compares `package.json` field by field and lists install-time scripts.
6. **Scans the published files for risky patterns**, deterministically and
   without executing anything: install scripts (and the files they run),
   dynamic code execution, decoded-then-executed payloads, process execution,
   credential and environment access combined with network use, obfuscation,
   hooks on browser network functions near wallet code, hard-coded endpoints,
   unexpected executables, links that leave the package, text aimed at AI
   models, and a checksum or identity mismatch. Every finding carries evidence
   (file, line, column, snippet).
7. Compares what the package does with what the **source** shows (the
   capability differential): behavior the source already has is listed without
   severity, and a dangerous variant (a downloading command, a decoded payload)
   is never excused by a harmless form in the source.
8. Scores the findings with a documented model and chooses a verdict
   (`no-differences`, `needs-review`, `suspicious`, `inconclusive`). A single
   indicator can never make a package `suspicious`, and an unresolved source is
   never clean. The score comes with a per-finding breakdown so it can be
   recomputed. See [`docs/risk-model.md`](docs/risk-model.md).
9. Writes a deterministic JSON report ([contract](docs/report-schema.md)) and a
   text summary. It can also analyze a local `.tgz` file, such as a tampered
   copy.

Only npm and GitHub-hosted sources are supported.

**The scanner matches patterns in text.** It can miss obfuscated or dynamically
built code and files over its size limit, and it can match code that never
runs, so a low score is never a statement that a package is safe. On a corpus of
24 popular packages it reported no high or critical finding
([details](docs/risk-model.md)).

**Explaining differences.** A difference is explained only from evidence: a
source map whose embedded source is byte-identical to repository files, a
generated file that references such a map and is fully described by it, a
declarations-only `types` entry with matching source, additive publish metadata
in `package.json`, or files left out by a literal `files` list. There is no list
of file names. Everything else is `unexplained`, a forged map is never evidence,
and explained files are still scanned: any finding rules out
`expected-differences`. Limits: bundler/`tsconfig` configuration is not read, and
a valid map does not prove a file equals real compiler output. With `--ai`,
Gemma gives an advisory opinion, which is not evidence and does not change the
verdict. See [`examples/`](examples) for real output.

## Planned

- Release monitoring, an analysis API and an analysis dashboard.

## AI models

With `--ai`, two open-weight models interpret the result, entirely on your
machine through [Ollama](https://ollama.com). There is no cloud LLM provider and
no cloud fallback, and no other local model is ever substituted.

| Model | Role |
|---|---|
| `gemma4:e4b` | First-pass classification of every file that differs from the source: expected artifact, suspicious, or needs investigation |
| `deepseek-r1:8b` | Deeper investigation of the strongest scanner findings, including obfuscated code: what the quoted code appears to do, the implications, and what remains uncertain |

They run one after the other (each is unloaded after use, so they fit in 16 GB),
and only when there is something to interpret. The deterministic analysis is the
source of truth: the models cannot add or remove a finding, change a hash, or
change the score or verdict, and the report is verified byte-identical outside
`ai` afterwards. Their output is checked against the findings and files it
refers to, and a file the scanner flagged cannot be cleared as an expected
artifact. If Ollama is not running or a model is missing, deterministic analysis
still completes and the report says what was unavailable. See
[`docs/ai-analysis.md`](docs/ai-analysis.md) for the guarantees and what running
the models locally showed (timings, failure modes).

```bash
ollama pull gemma4:e4b
ollama pull deepseek-r1:8b
npm run analyze -- --tarball examples/tampered-demo/debug-4.4.1-tampered.tgz --ai
```

The models can be wrong, and `--ai` takes from about 15 seconds (classification
only) to a few minutes (investigation with the reasoning model).

## Requirements

- Node.js 22.12 or newer (CI uses Node 24, see `.nvmrc`)
- npm 10 or newer
- Optional, for the planned AI features: Ollama with both models pulled

```bash
ollama pull gemma4:e4b
```

```bash
ollama pull deepseek-r1:8b
```

## Getting started

Install dependencies:

```bash
npm install
```

### Analyze a package

```bash
npm run analyze -- debug@4.4.1
```

The version must be exact (`name@1.2.3` or `@scope/name@1.2.3`). Needs network
access to `registry.npmjs.org` and `codeload.github.com`; no Ollama and no API
keys. Options:

| Option | Effect |
|---|---|
| `--json` | Print the full JSON report instead of the text summary |
| `--out <file>` | Also write the JSON report to a file |
| `--ai` | Also interpret the result with the two local models (see "AI models"). Advisory only. Needs Ollama running locally. |
| `--tarball <file.tgz>` | Analyze a local tarball instead of downloading it. The registry metadata and the source are still looked up for the package it names. |

Exit codes: `0` report produced, `1` analysis failed (for example a network
error), `2` invalid input. A report can be `inconclusive` and still exit `0`.
Analyze a local copy, for example the deliberately modified one in the examples:

```bash
npm run analyze -- --tarball examples/tampered-demo/debug-4.4.1-tampered.tgz
```

### Run the server and dashboard

The server and dashboard currently show only service and model status. Analysis
is available from the command line, not yet from the API or UI.

Start the API server on http://127.0.0.1:8787:

```bash
npm run dev:server
```

In a second terminal, start the dashboard on http://127.0.0.1:5173. It proxies
`/api` to the server:

```bash
npm run dev:web
```

Check health directly:

```bash
curl http://127.0.0.1:8787/api/health
```

`/api/health` reports Ollama connectivity and whether each required model is
installed. It only lists models (`GET /api/tags`), so it never loads a model or
runs inference.

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8787` | API server port |
| `HOST` | `127.0.0.1` | API server bind address |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Must be a loopback address. Remote hosts are rejected. |

No API keys or secrets are needed.

## Testing

```bash
npm test
```

```bash
npm run build
```

Tests use Node's built-in test runner. They never touch the network, contact
Ollama or download models: registry and GitHub responses are faked, and the
hostile archives used in the security tests (path traversal, links, decompression
bombs, truncated and corrupt tarballs) are built inside the tests. CI
(`.github/workflows/ci.yml`) runs install, tests and the frontend build on every
pull request.

## Repository layout

```
server/     Express API, analysis core and CLI (ES modules)
web/        React + Vite dashboard
docs/       Report contract and an illustrative sample report
examples/   Real inputs and outputs produced by Audyssey (see examples/README.md)
.github/    CI workflow and pull request template
```

## Security principles

- Package archives, source files, metadata and model output are all treated as
  untrusted.
- Audited code is never executed, and `npm install` is never run against it.
- No API endpoint exposes the local filesystem.
- Model output is kept separate from deterministic findings and cannot override
  them.
- Findings describe what code attempts. Suspicious is not reported as proven
  malicious.

## AI-assisted development

Claude Code is used as a development assistant to help write this repository,
and each pull request discloses it. It is not part of the product: Audyssey
uses only the local models listed above.

## License

[MIT](LICENSE)
