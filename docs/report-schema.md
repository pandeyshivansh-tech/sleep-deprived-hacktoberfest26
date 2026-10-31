# Audyssey report contract (v0.2.0)

This document defines the JSON report that the analysis pipeline, the API, the
CLI and the dashboard share. The team builds against this contract in
parallel, so any change to it should come in its own PR.

An illustrative, hand-written instance lives in
[`report.sample.json`](report.sample.json). It describes a fictional package
and is **not** output from Audyssey. Real outputs go in `examples/`.

The enumerations below are also exported from
[`server/src/report/schema.js`](../server/src/report/schema.js), and
`validateReport()` checks that a report is internally consistent.

## Principles

- **Deterministic results are the source of truth.** `files`, `findings` and
  `summary` come only from deterministic analysis.
- **AI output is advisory and kept separate.** Everything produced by a model
  lives under `ai`. AI entries refer to existing files and findings by ID. They
  can never add files, change hashes or remove or downgrade findings.
- **Every finding has evidence.** Each finding links to a file and carries at
  least one `{ path, line, snippet }` evidence item.
- **Suspicious is not proven malicious.** Verdicts and descriptions say what the
  code attempts, not what it achieved.

## Top-level fields

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | string | `"0.2.0"` |
| `tool` | `{ name, version }` | Producer of the report |
| `generatedAt` | ISO-8601 string | Generation time |
| `input` | object | What was requested (see below) |
| `package` | object | Published artifact details |
| `source` | object | Resolved source snapshot and how confident we are in it |
| `summary` | object | Deterministic verdict, score and counts |
| `files` | array | One entry per path present in the package, the source, or both |
| `manifest` | object | Semantic comparison of the package and source `package.json` |
| `findings` | array | Deterministic security findings |
| `ai` | object | Model runs and their advisory output |
| `errors` | array of `{ stage, message }` | Non-fatal problems encountered during analysis |

### `input`

| Field | Values |
|---|---|
| `ecosystem` | `npm` |
| `name`, `version` | Requested package name and exact version |
| `source` | `registry` (downloaded from npm) or `tarball` (supplied locally) |

### `package`

`name`, `version`, `tarballUrl`, `fileCount`, `totalBytes`, plus:

- `integrity`: `{ expected, actual, verified }`. `expected` is the registry's
  `dist.integrity`, and `actual` is computed from the downloaded or supplied
  tarball.
- `provenance`: `{ attestationPresent, claimedRepository, claimedCommit }` from
  npm provenance metadata, when present.

### `source`

| Field | Description |
|---|---|
| `resolved` | Whether a source snapshot was obtained |
| `repository` | Normalized repository URL, or `null` |
| `directory` | Package subdirectory for monorepos (`repository.directory`), or `null` |
| `ref` | `{ type: "gitHead" \| "tag" \| "none", value, commit }` |
| `confidence` | `exact-commit`, `tag` or `unresolved` |
| `notes` | Human-readable provenance notes and uncertainties |

### `summary`

- `verdict`: `no-differences`, `expected-differences`, `needs-review`,
  `suspicious` or `inconclusive`
- `riskScore`: integer from 0 to 100, or `null` when no security assessment was
  performed. `null` is only valid together with the `inconclusive` verdict, so a
  score is never invented.
- `counts`: `{ identical, modified, packageOnly, sourceOnly }`, which must match
  `files`
- `findingsBySeverity`: `{ info, low, medium, high, critical }`, which must
  match `findings`

### `files[]`

| Field | Description |
|---|---|
| `id` | Unique ID (`f1`, `f2`, …) |
| `path` | Path relative to the package root |
| `status` | `identical`, `modified`, `package-only` or `source-only` |
| `package` / `source` | `{ sha256, size, type }`, or `null` when absent on that side. `type` is `file`, `symlink` or `hardlink` (optional). For links, `sha256` hashes the link target text and `size` is its length. |
| `explanation` | `{ category, confidence, evidence[] }` |
| `findingIds` | IDs of findings that concern this file |

`explanation.category` is one of `identical`, `generated-artifact`,
`publish-normalization`, `not-published`, `unexplained` or `unclassified`.
`unclassified` means the difference is reported by hash only: no explainer or
scanner has judged it, so it is neither expected nor suspicious. `unexplained`
is a judgement that evidence was looked for and not found. `confidence` is
`high`, `medium` or `low`.

### `manifest`

| Field | Description |
|---|---|
| `compared` | `true` when both `package.json` files were read and compared |
| `reason` | Why the comparison was not made (`null` when `compared` is `true`) |
| `changes` | `{ field, change, packageValue, sourceValue }` entries, sorted by `field`. `field` is a dotted path (for example `scripts.postinstall`); `change` is `added` (absent from the source), `removed` (absent from the package) or `changed`. The absent side's value is `null`; long values are truncated. |
| `installScripts` | `{ package, source }`: the install-time scripts (`preinstall`, `install`, `postinstall`) defined on each side, as name to command |

### `findings[]`

| Field | Description |
|---|---|
| `id` | Unique ID (`F1`, `F2`, …) |
| `ruleId` | Stable rule identifier, for example `lifecycle-script-added` |
| `severity` | `info`, `low`, `medium`, `high` or `critical` |
| `confidence` | `high`, `medium` or `low` |
| `title`, `description` | Human-readable summary |
| `fileId` | The `files[].id` this finding concerns |
| `introducedInPackage` | `true` when the behavior has no counterpart in the source |
| `evidence` | Non-empty array of `{ path, line, snippet }` |

### `ai`

| Field | Description |
|---|---|
| `status` | `completed`, `partial`, `unavailable`, `skipped` or `failed` |
| `runs` | `{ stage, model, digest, durationMs, status }` for each model call. `stage` is `classification` (`gemma4:e4b`) or `investigation` (`deepseek-r1:8b`). |
| `classifications` | `{ fileId, label, rationale }`. `label` is `expected-artifact`, `suspicious` or `needs-investigation`. |
| `investigations` | `{ findingId, explanation, implications, uncertainty }` |

When Ollama is unreachable or a model is not installed, `ai.status` is
`unavailable`, the AI arrays are empty, and every deterministic field is still
populated.
