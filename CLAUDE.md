# CLAUDE.md: Audyssey

Guidance for Claude Code working in this repository. Keep it accurate: when a
milestone lands, update the **Status** section in the same PR.

## What Audyssey is

Audyssey ("Know what you're actually installing.") compares a published npm
package version with the source repository it claims to come from. It explains
each difference, separates normal build output from unexpected changes, and
flags suspicious modifications with evidence.

Built by team Sleep Deprived for Hacktoberfest 2026 Hack Day Sonipat, Problem 04
("Published Package vs Source Code Integrity Analyzer"). The problem statement
and judging rules are in the organizers' PDFs, not in this repo. The relevant
points are summarized under **Hackathon rules** below.

## Status: M0, M1, M2, M2b, M3, M4 and M5 exist

Implemented, M0 (merged in PR #1):
- npm workspaces `server/` (Express 5, ES modules) and `web/` (React 19 + Vite 8)
- `GET /api/health`: Ollama connectivity and model availability
- A dashboard page that shows that health status, and nothing else
- The report contract (`docs/report-schema.md`) with `validateReport()`
- CI, the PR template, LICENSE (MIT), README

Implemented, M1 (deterministic npm analysis; CLI only):
- `npm run analyze -- name@1.2.3 [--json] [--out f] [--tarball f.tgz]`
- npm registry metadata + tarball fetch with a `dist.integrity` check
- Source resolution on GitHub: `gitHead`, then version tags, else unresolved;
  the source `package.json` must name the same package; monorepo
  `repository.directory` supported
- Bounded in-memory tar.gz reading, SHA-256 inventory, file diff
  (identical / modified / package-only / source-only), `package.json` diff
- Report contract v0.3.0 output, real `examples/`

Implemented, M2 (deterministic scanner; see `docs/risk-model.md`):
- `server/src/scan/`: pattern-based scanner over the published files (text, never
  executed), 22 rule ids (install scripts, dynamic and decoded execution, process
  execution, credentials + network, obfuscation, network hooks near wallet code,
  hard-coded endpoints, native binaries, escaping links, text aimed at AI models,
  integrity/identity mismatch), the capability differential against the source,
  and a documented risk score with a per-finding breakdown and a verdict decision
  table
- Reports now have `scan.performed: true`, findings with evidence, a score and
  one of `no-differences`, `needs-review`, `suspicious`, `inconclusive`
- Differences are classified by the M2b explainer (below); without a resolved
  source they stay `unclassified`.

Implemented, M2b (evidence-based explainer, `server/src/explain/`):
- Source maps are recognised by content (v3, `sources`, `mappings`); embedded
  `sourcesContent` is compared by SHA-256 with the repository. Generated files
  are explained via `sourceMappingURL` plus line coverage; `types` entries via
  declarations-only content plus a same-stem source; `package.json` as
  `publish-normalization` only for added, non-behavioral fields; `files` lists
  for `not-published`. No file-name or extension lists. A forged map and an
  entry point alone are `unexplained`. Explained files are still scanned, and
  `expected-differences` needs every difference explained and no finding of low
  severity or above. Build configuration beyond `package.json` is not read.

Implemented, M3 (report dashboard, `web/`):
- A dark-first React dashboard that **views reports**: open a `report.json` (file
  picker or drop) or one of the three bundled real examples. Every report is
  checked with the backend's own `validateReport` (imported from
  `server/src/report/schema.js`, not copied) before rendering; invalid, wrong
  version, oversized and non-report files show a described error.
- Views: workspace, overview (verdict, score and breakdown, severity, integrity,
  source resolution, file counts, scan coverage, AI status, `package.json`
  changes), file explorer (search by path or hash prefix; filter by difference,
  explanation category, unexplained, findings, model-flagged; hashes, sizes,
  explainer evidence), findings (evidence with path:line, linked files), and a
  Local AI page. Model output is always shown apart from, and labelled as advisory
  next to, deterministic results.
- Logic is in `web/src/lib/` (`report-load.js`, `report-view.js`, `examples.js`) and
  tested in `web/test/`. The UI starts no analysis and has no API route behind it.
  No `dangerouslySetInnerHTML`; package text is rendered as text; only https
  GitHub repository URLs become links. No new dependencies; transitions are CSS.

Implemented, M5 (analysis API and upload; `server/src/api/`, `server/src/jobs/`):
- `POST /api/analyze` takes the raw `.tgz` as the body, `GET /api/jobs/:id`,
  `GET /api/jobs/:id/report` (see **API**). Jobs are in memory and ephemeral. The
  existing pipeline (`analyzeNpmPackage` with `tarballBytes`, the bounded archive
  reader, scanner, explainer, optional `addLocalAnalysis`) is reused unchanged.
- The dashboard uploads a `.tgz`, shows real queued/running/completed/failed state
  and pipeline steps, and opens the validated report in the existing views, marked
  Fresh analysis / Opened from a file / Bundled example.

Implemented, M4 (local models; see `docs/ai-analysis.md`):
- `--ai` (CLI only, opt-in): `gemma4:e4b` classifies the files that differ, then
  `deepseek-r1:8b` explains the strongest findings, through the local Ollama only.
  Output goes under `report.ai`; the rest of the report is verified byte-identical
  afterwards, a flagged file cannot be cleared as `expected-artifact`, and every
  entry must refer to a real file or finding. Unavailable Ollama or models degrade
  to `ai.status: unavailable | partial | failed` with the deterministic report
  intact. Real inference was run and recorded in `examples/`.

**Not implemented yet:** analysis by package name from the API or UI (only uploaded `.tgz` files), job persistence or cancellation, authentication, release monitoring, PyPI, non-GitHub
sources, verification of npm provenance attestations (presence is reported, never
verified). Never describe these as working, in code comments, the README, UI copy
or PR descriptions. UI text must not pretend a feature works. The scanner is heuristic: never describe a
low score or an empty findings list as "safe".

Planned milestones (each one is its own PR):
- M2b (done): the evidence-based build-artifact explainer above
- M5 (done): async job API and `.tgz` upload
- M6: `examples/` with real outputs, a release-monitoring `watch` command,
  README

## Layout

```
server/src/index.js          entry: loadConfig() + listen
server/src/app.js            createApp({ ollamaBaseUrl, fetchImpl, analysisFetchImpl, analyzeImpl, analysis }); routes
server/src/api/analysis.js   POST /api/analyze, GET /api/jobs/:id[/report]: raw-body upload, limits, sanitizing
server/src/jobs/manager.js   in-memory job store, queue, capacity, public error mapping, report validation
web/src/lib/analysis-client.js  upload + polling client (injected fetch), tested without a server
server/src/config.js         REQUIRED_MODELS, PORT/HOST/OLLAMA_BASE_URL, loopback check
server/src/health.js         getHealth(): builds the /api/health payload
server/src/ai/ollama.js      listInstalledModels() (GET /api/tags), chat() (the only inference call), stripThinking, extractJsonArray
server/src/ai/prompts.js     system prompts; untrusted() fences, defangs and caps quoted package text
server/src/ai/classify.js    stage 1 (gemma4:e4b): candidates, batches, validateClassifications
server/src/ai/investigate.js stage 2 (deepseek-r1:8b): candidates, validateInvestigations
server/src/ai/run.js         addLocalAnalysis(): runs both stages in order, proves the deterministic part is unchanged
server/src/errors.js         InputError / FetchError / ArchiveError (stable `code`s)
server/src/limits.js         archive, download and timeout caps (package vs source)
server/src/net/safe-fetch.js host allowlist, manual redirects, size/time caps
server/src/ecosystems/npm/   spec.js (name/version validation), registry.js (metadata, tarball, integrity)
server/src/source/           repository.js (repo URL parsing), resolve.js (gitHead -> tag -> unresolved)
server/src/archive/          tar.js (bounded tar.gz reader), inventory.js (SHA-256 inventory)
server/src/compare/          diff.js (file diff), manifest.js (package.json diff)
server/src/analyze.js        analyzeNpmPackage(): the pipeline -> { report, analysis }
server/src/scan/             index.js (scanPackage), indicators.js (every pattern, one table), rules/ (code-patterns.js, structure.js), finding.js, risk.js + weights.js (score, verdict), categorize.js, text.js
server/src/report/           schema.js (enums, validateReport), build.js (numbers, links and scores findings), summary.js (text)
server/scripts/scan-corpus.mjs  acceptance run over benign packages (needs network; not in CI)
server/src/cli.js            run(argv, io): the CLI; server/bin/audyssey.js is the entry
server/test/*.test.js        node:test suites (every file in test/ is run as a test)
server/test-support/         test helpers: fake-fetch, tar-builder (hostile archives), scenario, fake-ollama (scripted models, tracks concurrency)
web/src/App.jsx              app shell: navigation, system status, open-report state
web/src/components/          Workspace, Overview, FileExplorer, Findings, AiPanel, SystemStatus, ui
web/src/lib/                 health.js, report-load.js (validate), report-view.js (filter/summaries), examples.js (bundled real reports)
web/test/*.test.js           node:test suites for web/src/lib
docs/report-schema.md        report contract v0.3.0 (source of truth)
docs/ai-analysis.md          what the two models do, guarantees, measured local behavior, failure modes
docs/risk-model.md           scanner rules, weights and why, verdict table, measured results, limits
docs/report.sample.json      hand-written, fictional sample; not real output
examples/                    REAL tool output: debug@4.4.1, mitt@3.0.1, tampered-demo
```

## Commands

Requires Node.js >= 22.12. CI uses Node 24 (`.nvmrc`).

| Task | Command |
|---|---|
| Install | `npm install` (CI uses `npm ci`) |
| All tests | `npm test` (runs `node --test` in each workspace) |
| Frontend build | `npm run build` |
| Analyze a package | `npm run analyze -- name@1.2.3` (needs network; `--json`, `--out <file>`, `--tarball <file>`, `--ai`) |
| Scanner acceptance run | `node server/scripts/scan-corpus.mjs [name@x.y.z ...]` (needs network; run it after any rule or weight change) |
| API server | `npm run dev:server` serves `http://127.0.0.1:8787` with `--watch` (`npm start` runs it without) |
| Dashboard | `npm run dev:web` serves `http://127.0.0.1:5173` and proxies `/api` to 8787 |

Always run `npm test` and `npm run build` before declaring work done. Both
must pass in CI on every PR.

## API (current)

- `GET /api/health` returns `{ status: "ok", service: "audyssey-server",
  version, ollama: { baseUrl, reachable, latencyMs, error }, models: [{ name,
  role, installed, digest }], ai: { ready } }` with `Cache-Control: no-store`.
  - `status` is always `"ok"` when the server runs. Ollama being down degrades
    only AI features.
  - `installed` is `null` (unknown) when Ollama is unreachable. Model names
    are matched by exact tag.
  - It must never load a model or run inference, so it calls only
    `/api/tags` with a 2 s timeout.
- Any other `/api/*` route returns 404 `{ "error": "Not found" }`. Unhandled
  errors return 500 `{ "error": "Internal server error" }`, and internal
  details are never sent to clients.
- `POST /api/analyze[?ai=1&filename=x.tgz]`: the request body is the `.tgz` itself
  (`Content-Type: application/gzip`, `application/x-gzip`, `application/octet-stream`
  or `application/x-tar`; other types get `415`, which also stops other websites
  from starting jobs without a CORS preflight). Read under a 25 MB limit
  (`MAX_UPLOAD_BYTES`; `413 too-large`), `Content-Encoding` is refused (`400`), empty
  bodies `400 empty-upload`, bodies without the gzip magic `400 not-gzip`, and a full
  server `429 busy` (checked before the body is read). Success is `202` with
  `{ id, state, filename, ai, createdAt, updatedAt, queuePosition, progress[],
  error, reportUrl }` and a `Location` header. The file name is display-only,
  sanitized and never used as a path.
- `GET /api/jobs/:id`: the same job object. `state` is `queued | running |
  completed | failed`; `progress` holds the pipeline's real step messages (at most
  40); `error` is `{ code, message }` for failures (authored pipeline messages only;
  anything unexpected becomes a generic message and is logged server-side). Ids are
  32 hex characters from `crypto.randomBytes`; anything else, or an id the server
  does not hold, is `404 unknown-job`.
- `GET /api/jobs/:id/report`: the validated report, or `409 not-ready` until the
  job completed. A report that fails `validateReport` is discarded and the job
  fails with `invalid-report`.
- Jobs are in memory (`server/src/jobs/manager.js`): one running, two queued, 50
  retained, one hour TTL; the uploaded bytes are released when the analysis ends.
  Nothing is written to disk and no database or queue service is used.
- No endpoint accepts a filesystem path, URL, repository or command. The CLI may
  read a `--tarball` path the user passes on their own machine; an HTTP API may
  never do that. `createApp({ fetchImpl })` is the Ollama fetch and
  `analysisFetchImpl` the registry/GitHub fetch; tests replace both.

## Report contract

`docs/report-schema.md` defines the report. Its enums live in
`server/src/report/schema.js`, and `validateReport(report)` returns a list of
problems (an empty list means the report is valid). Changing the contract means
updating the doc, `schema.js`, `report.sample.json` and the tests together, in
their own PR (as was done for v0.2.0 and v0.3.0). The key invariants, which
`validateReport` enforces:
- `summary.riskScore` is `null` exactly when `scan.performed` is `false`, and
  then the verdict is `inconclusive` and there are no findings. Never invent a
  score; a non-null score must be reproducible from `summary.scoring`.
- `suspicious` needs high or critical findings from at least two distinct
  rules. `no-differences` and `expected-differences` need a resolved source;
  `expected-differences` also needs every difference explained. `inconclusive`
  never carries a medium-or-higher finding.
- Files that were not scanned are listed in `scan.filesSkipped`; "no findings"
  is never "safe". Package-scope findings (such as `integrity-mismatch`) have
  `fileId: null`.
- `files[].status` is identical, modified, package-only or source-only, and
  each status matches which side has a hash and whether the hashes agree.
- `summary.counts` and `summary.findingsBySeverity` match the arrays.
- Every finding has a valid `fileId` and at least one evidence item
  `{ path, line, snippet }`.
- `ai.classifications` and `ai.investigations` may only reference existing
  file and finding IDs.

## Local AI (Ollama only)

| Model | Role (`REQUIRED_MODELS`) | Planned use |
|---|---|---|
| `gemma4:e4b` | `classification` | First pass on each difference: `expected-artifact`, `suspicious` or `needs-investigation` |
| `deepseek-r1:8b` | `investigation` | Deeper look at flagged or ambiguous items, including obfuscated code: implications and uncertainty |

- Inference is only ever local Ollama. `resolveOllamaBaseUrl` rejects
  anything other than localhost, 127.0.0.1 or [::1]. Never add OpenAI,
  Anthropic, Gemini or any other cloud LLM API, SDK or fallback.
- `HACKATHON.md` promises both models, including DeepSeek de-obfuscation.
  Claiming a model the code doesn't use costs points, so both must have real
  call paths. Record model, digest and duration in `ai.runs`.
- Call the models one after the other, with `keep_alive: 0` so each is unloaded.
  Running both together (about 15 GB) doesn't fit comfortably on the team's 16 GB
  laptop.
- Measured behavior that the client depends on: `gemma4:e4b` needs `think: false`
  (otherwise it spends its token budget thinking) and stalls with a JSON-schema
  `format`, so it is prompted for plain JSON; `deepseek-r1:8b` always reasons
  first (large `num_predict`, long timeout) and its `<think>…</think>` must be
  stripped before parsing. Re-measure before changing any of this.
- If Ollama or a model is unavailable, `ai.status` is `unavailable` (or `partial`
  if one stage ran). Deterministic analysis must still complete.

## Deterministic results vs AI output

- Deterministic analysis is the source of truth for `files`, `findings` and
  `summary`.
- AI output goes only under `ai`, labels items by existing ID, and is
  schema-validated. Drop any entry that references unknown IDs, files or
  hashes.
- AI must never invent files, hashes, evidence or findings, and must never
  remove, downgrade or suppress a deterministic finding. If it disagrees, show
  both.
- Wording: say "suspicious" or "attempts to", never "malicious" or "exfiltrated"
  as a proven fact. An outbound request is not proof of exfiltration.
- The artifact explainer must cite evidence (entry points, build config, source
  maps whose `sourcesContent` matches the repo). Do not build an ever-growing
  allowlist. A file being "generated" never exempts it from security scanning.

## Security rules for analysis code (mandatory)

All package archives, source archives, manifests, file contents and model
output are **untrusted input**.
- Never execute, `require` or `import` audited code. Never run `npm install`,
  lifecycle scripts or build scripts against an audited package or repository.
- Read archives **in memory** under hard caps (`server/src/archive/tar.js`,
  `limits.js`). Do not extract them to disk. Normalize paths, and reject
  absolute paths, `..` segments, backslashes and entries outside the single
  top-level directory. Reject duplicate paths, devices/FIFOs and data after the
  end-of-archive marker. Do not skip a bad entry silently: throw `ArchiveError`.
- Record symlinks and hardlinks as entries. Never follow or materialize them.
- Enforce limits on entry count, per-file size, total uncompressed size,
  compression ratio (archive bombs) and path depth. Exceeding one is an
  analysis error, never a silent truncation.
- Network access only to an allowlist (`registry.npmjs.org`,
  `codeload.github.com`, `github.com`), always through `safeFetchBuffer`.
  Validate npm names and versions before building URLs (`spec.js`), treat
  metadata-supplied URLs as untrusted, and re-check hosts on redirects.
- Subprocesses (for example `git ls-remote`) only with fixed argument arrays,
  never through a shell.
- Scanning: the scanner only matches text. It never executes, `eval`s, imports or
  `vm`-runs anything from a package, and snippets quoted from a package are
  sanitized (control characters, bidirectional overrides) before they are stored or
  printed. Never suppress matches because they look like they sit inside a string
  or comment unless the masking is conservative (`text.js`): an attacker controls
  the file.
- Prompt injection: put untrusted text inside clearly delimited blocks, never
  let model output change deterministic results, and treat text aimed at an
  LLM inside a package as a finding.
- The dashboard renders package content as text only. Never use
  `dangerouslySetInnerHTML`.
- No secrets in the repo. The optional `GITHUB_TOKEN` comes from the
  environment only, and `.env*` is gitignored.

## Code conventions

- ES modules everywhere (`"type": "module"`), 2-space indent, single quotes,
  semicolons, trailing commas. Match the surrounding style.
- Keep side effects at the edges. Pass dependencies in as parameters so tests
  can substitute them, as `createApp({ fetchImpl })` and
  `listInstalledModels({ fetchImpl })` do. Keep React components thin and put
  logic in pure modules under `web/src/lib/` so `node:test` can cover it.
- Comments explain *why* (security reasons, invariants), not *what*.
- Add a dependency only when the standard library or existing dependencies
  can't do the job reasonably, and justify it in the PR. The current runtime
  dependencies are express, react and react-dom; the dev dependencies are vite
  and @vitejs/plugin-react.

## Testing expectations

- Use `node:test` with `node:assert/strict`. There is no other test framework.
  Keep helpers in `server/test-support/`: `node --test` runs every file under a
  `test/` directory.
- Tests must never contact Ollama, download model weights or need network
  access. Inject fake `fetch` responses; `server/test/health.test.js` shows
  the pattern, including asserting which URLs were requested.
- Archive-security code needs tests with archives built inside the tests
  (`test-support/tar-builder.js`): traversal, absolute paths, symlinks,
  hardlinks, oversized files, too many entries, gzip bombs.
- `server/test/examples.test.js` keeps `examples/` contract-valid,
  tool-generated and tied to the tarball committed beside it. Regenerate
  examples with the tool; never edit them by hand.
- Each scanner rule needs a positive and a negative fixture
  (`server/test/scan-rules.test.js`). Regex patterns run on attacker-controlled
  text: no nested quantifiers, and every new pattern needs a hostile-input case in
  `scan-robustness.test.js`. A weight or rule change must be followed by the
  corpus run (zero high findings on benign packages), a bump of `MODEL` /
  `RULES_VERSION`, `docs/risk-model.md` and regenerated examples. Attack fixtures
  are inert, defanged text that is scanned and never run
  (`scan-incidents.test.js`); do not commit real malware.
- AI handling needs tests for malformed output, invented IDs and injection text;
  they use `test-support/fake-ollama.js`, never a real model. A real-inference run
  is part of finishing an AI change (`--ai` on the tampered example and one
  clean package), and its output goes in `examples/`.

## Git and PR workflow

- `main` is PR-only. Never commit or push to it directly, never force-push,
  and never rewrite merged history.
- Work on a branch from up-to-date `main`. Commit or push only when the user
  asks.
- **Never modify `HACKATHON.md`.** It is the required first commit and must
  stay byte-identical.
- Every PR body follows `.github/pull_request_template.md` with these four
  headings, unchanged:
  `## What this PR does`, `## Models the product uses in this PR`,
  `## AI coding assistants that helped write it`, `## How we tested it`.
  - Models: list only models the PR's code actually calls, or `none`. A health
    check that lists models is not a model use.
  - AI coding assistants: name **Claude Code** when it helped. It is a
    development assistant and never part of the product.
- CI (`.github/workflows/ci.yml`) runs `npm ci`, then `npm test`, then
  `npm run build` on every PR and on pushes to `main`. It must pass before
  merge, and it must pass on the final commit.
- `gh` is not installed on the team's machine. The user opens PRs in the
  GitHub web UI.

## Hackathon rules that constrain the code

- The repo is fetched and frozen at **06:30 IST, 1 Nov 2026**. Anything later
  doesn't count. Keep `main` green.
- Required files: `LICENSE` (MIT), `HACKATHON.md`, `README.md`, the PR
  template, `ci.yml`, and `examples/` with **real** inputs and the actual
  outputs the tool produced. Never put hand-written output in `examples/`.
- Automated scoring checks: CI passes, features are real (not stubs), tests
  exist, there are no secrets, and the named models are used. Claiming an
  unused model scores 0 for AI use and **−5 overall**.
- Panel judging: problem understanding, live demo, design and trade-offs. Any
  team member may be asked about any code, so keep it explainable.
- Use public data only. Never post automated issues or comments to real
  projects.
