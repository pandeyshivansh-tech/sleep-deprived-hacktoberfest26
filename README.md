# PackageLens

**Know what you're actually installing.**

PackageLens compares a published npm package with the source repository it
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
| Package retrieval, source resolution, safe extraction, file diff | Planned (M1) |
| Deterministic security scanner and build-artifact explainer | Planned (M2) |
| Gemma and DeepSeek analysis through local Ollama | Planned (M4) |
| Full analysis dashboard, CLI and examples | Planned (M3–M6) |

The tool cannot analyze packages yet. This README describes only what exists,
and each milestone PR updates it.

## How it will work

1. Fetch the exact package version from the npm registry and verify the
   tarball against the registry's integrity hash.
2. Resolve the source snapshot: the exact commit from `gitHead` when available,
   otherwise a matching version tag, and report the confidence of that match.
3. Read both archives in memory without ever executing package code or running
   install scripts.
4. Hash every file (SHA-256) and classify it as identical, modified,
   package-only or source-only.
5. Explain differences using evidence such as build configuration, entry points
   and source maps, not a hard-coded allowlist.
6. Run deterministic security checks: lifecycle scripts, credential and
   environment access, network calls, obfuscation, dynamic execution, and
   behaviors present in the package but absent from the source.
7. Optionally ask two local models to interpret that evidence (see below).

The report format is defined in [`docs/report-schema.md`](docs/report-schema.md).

## AI models

All inference runs locally through [Ollama](https://ollama.com). There is no
cloud LLM provider and no cloud fallback.

| Model | Role |
|---|---|
| `gemma4:e4b` | First-pass classification of differences: expected artifact, suspicious, or needs investigation |
| `deepseek-r1:8b` | Deeper investigation of suspicious or ambiguous findings, including obfuscated code, and explanation of their security implications and uncertainty |

The deterministic analysis is the source of truth. Models only annotate
existing evidence: they cannot add files, change hashes, or remove findings.
If Ollama is not running, deterministic analysis still works.

## Requirements

- Node.js 22.12 or newer (CI uses Node 24, see `.nvmrc`)
- npm 10 or newer
- Optional, for AI features: Ollama with both models pulled

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

Tests use Node's built-in test runner and never contact Ollama or download
models. CI (`.github/workflows/ci.yml`) runs install, tests and the frontend
build on every pull request.

## Repository layout

```
server/     Express API and analysis core (ES modules)
web/        React + Vite dashboard
docs/       Report contract and an illustrative sample report
examples/   Real inputs and outputs produced by PackageLens
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
and each pull request discloses it. It is not part of the product: PackageLens
uses only the local models listed above.

## License

[MIT](LICENSE)
