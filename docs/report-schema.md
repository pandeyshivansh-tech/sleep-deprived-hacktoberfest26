# Audyssey report contract (v0.3.0)

This document defines the JSON report that the analysis pipeline, the API, the
CLI and the dashboard share. The team builds against this contract in
parallel, so any change to it should come in its own PR.

An illustrative, hand-written instance lives in
[`report.sample.json`](report.sample.json). It describes a fictional package
and is **not** output from Audyssey. Real outputs go in `examples/`.

The enumerations below are also exported from
[`server/src/report/schema.js`](../server/src/report/schema.js), and
`validateReport()` checks that a report is internally consistent. Several rules
below (marked **enforced**) are checked there, so a producer cannot emit a
report that claims more than its evidence supports.

## Principles

- **Deterministic results are the source of truth.** `files`, `findings`,
  `scan` and `summary` come only from deterministic analysis.
- **AI output is advisory and kept separate.** Everything produced by a model
  lives under `ai`. AI entries refer to existing files and findings by ID. They
  can never add files, change hashes or remove or downgrade findings.
- **Every finding has evidence.** Each finding carries at least one evidence
  item that points at a real file, with a line and a bounded snippet.
- **Suspicious is not proven malicious.** Verdicts and descriptions say what the
  code attempts, not what it achieved.
- **No findings is not "safe".** The scanner is a set of heuristics (see
  `scan`), so an absent finding only means no rule matched in the files that
  were scanned.
- **Nothing is hidden.** Files that could not be scanned are listed in
  `scan.filesSkipped`; they are never treated as clean.

## Top-level fields

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | string | `"0.3.0"` |
| `tool` | `{ name, version }` | Producer of the report |
| `generatedAt` | ISO-8601 string | Generation time |
| `input` | object | What was requested (see below) |
| `package` | object | Published artifact details |
| `source` | object | Resolved source snapshot and how confident we are in it |
| `summary` | object | Deterministic verdict, score and counts |
| `files` | array | One entry per path present in the package, the source, or both |
| `manifest` | object | Semantic comparison of the package and source `package.json` |
| `findings` | array | Deterministic security findings |
| `scan` | object | What the scanner did and did not cover |
| `ai` | object | Model runs and their advisory output |
| `errors` | array of `{ stage, message }` | Non-fatal problems encountered during analysis |

### `input`

| Field | Values |
|---|---|
| `ecosystem` | `npm` |
| `name`, `version` | Requested package name and exact version |
| `source` | `registry` (downloaded from npm) or `tarball` (supplied locally) |

### `package`

`name`, `version`, `tarballUrl` (`null` for a supplied tarball), `fileCount`,
`totalBytes`, plus:

- `integrity`: `{ expected, actual, verified }`. `expected` is the registry's
  `dist.integrity`, and `actual` is computed from the downloaded or supplied
  tarball.
- `provenance`: `{ attestationPresent, claimedRepository, claimedCommit }` from
  npm provenance metadata, when present. Presence only; attestations are not
  verified.

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

| Field | Description |
|---|---|
| `verdict` | One of the verdicts below |
| `riskScore` | Integer from 0 to 100, or `null`. **Enforced:** `null` exactly when `scan.performed` is `false`. A score is never invented. |
| `scoring` | `null` when `riskScore` is `null`; otherwise how the score was computed (see below) |
| `counts` | `{ identical, modified, packageOnly, sourceOnly }`, which must match `files` |
| `findingsBySeverity` | `{ info, low, medium, high, critical }`, which must match `findings` |

#### Verdicts

| Verdict | Meaning | Enforced rules |
|---|---|---|
| `no-differences` | Every published file matches the source, and nothing was found | The source is resolved; no modified or package-only files; no findings of `low` or above. (Source-only files are not published, so they are not differences.) |
| `expected-differences` | There are differences, all explained as normal build or publish output | The source is resolved; every modified or package-only file is `generated-artifact` or `publish-normalization`; no findings of `medium` or above. The deterministic build-artifact explainer sets those categories from evidence (see [`risk-model.md`](risk-model.md#explaining-differences)); the pipeline additionally requires no finding of `low` or above. |
| `needs-review` | Something needs a human to look at it | none |
| `suspicious` | Several independent rules found strong indicators | Findings of `high` or `critical` from **at least two distinct rules**. A single indicator, however severe, can never produce this verdict. |
| `inconclusive` | No conclusion can be drawn | Not allowed together with findings of `medium` or above. Used when the source is unresolved, the package could not be read, or no scan was performed. A report with `scan.performed: false` can only be `inconclusive`. |

With an unresolved source, the capability differential is unavailable, so
`no-differences` and `expected-differences` are impossible. Findings of `low`
severity alone leave the verdict `inconclusive`; any finding of `medium` or
above makes it at least `needs-review`.

#### `scoring`

| Field | Description |
|---|---|
| `model` | Name of the producer's documented scoring model |
| `cap` | Always `100` |
| `rawTotal` | The sum of every contribution's `points`, rounded to 2 decimals |
| `contributions` | One entry per finding, exactly once: `{ findingId, ruleId, base, confidenceFactor, introducedFactor, repeatFactor, points }` |

**Enforced:** `points = round2(base × confidenceFactor × introducedFactor × repeatFactor)`,
each factor is above 0 and at most 1, and `riskScore = min(100, round(rawTotal))`.
Anyone can therefore recompute a score from the report alone.
`repeatFactor` lets a producer discount repeated findings from the same rule so
that repetition cannot inflate a score. The contract checks the arithmetic and
structure; the weights themselves belong to the producer's documented model.

### `files[]`

| Field | Description |
|---|---|
| `id` | Unique ID (`f1`, `f2`, …) |
| `path` | Path relative to the package root |
| `status` | `identical`, `modified`, `package-only` or `source-only` |
| `package` / `source` | `{ sha256, size, type }`, or `null` when absent on that side. `type` is `file`, `symlink` or `hardlink` (optional). For links, `sha256` hashes the link target text and `size` is its length. |
| `explanation` | `{ category, confidence, evidence[] }` |
| `findingIds` | IDs of the file-scope findings that concern this file. **Enforced** in both directions: a file lists exactly the findings whose `fileId` is that file. |

`explanation.category` is one of `identical`, `generated-artifact`,
`publish-normalization`, `not-published`, `unexplained` or `unclassified`.
`unclassified` means the difference is reported by hash only and was not judged
(the source could not be resolved, or it is a source-only file that no `files`
list covers): neither expected nor suspicious. `unexplained` is a judgement that
the explainer looked for evidence and did not find it. The explainer's evidence
lines are in `explanation.evidence`. `confidence` is `high`,
`medium` or `low`.

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
| `ruleId` | Stable kebab-case rule identifier, for example `install-script-added` |
| `severity` | `info`, `low`, `medium`, `high` or `critical` |
| `confidence` | `high`, `medium` or `low` |
| `scope` | `file` (about a file in `files`) or `package` (about the package as a whole) |
| `title`, `description` | Human-readable summary |
| `fileId` | The `files[].id` this finding concerns; `null` when `scope` is `package` |
| `introducedInPackage` | `true` when the behavior has no counterpart in the source, `false` when the source has it too, `null` when unknown (no source snapshot to compare with) |
| `evidence` | Non-empty array of evidence items (below) |

An evidence item is `{ path, line, snippet }` plus optional `column` and
`indicator`:

- `path` is a real `files[].path`. It may be `null` only for a package-scope
  finding, in which case `line` is `null` too.
- `line` and `column` are 1-based. Minified code is one long line, so `column`
  locates the match.
- `snippet` is at most 400 characters and is untrusted text from the package;
  consumers must render it as plain text.
- `indicator` names the pattern that matched (for example `env.secret`).

#### Package-scope findings

Two rule IDs are reserved for findings about the package as a whole. They exist
because the checksum comparison is the one signal that belongs to no file:

- **`integrity-mismatch`**: the tarball bytes that were analyzed do not match
  the checksum the npm registry publishes for this exact version
  (`dist.integrity`, or `dist.shasum` if that is all it publishes). For
  `input.source: "registry"` it means the download was corrupt or the registry
  served inconsistent data. For `"tarball"` it means the supplied file is not the
  published release. It is a statement about bytes, not about code, and it
  does not prove tampering by itself. It is not emitted when the registry
  publishes no checksum at all; that is a limitation listed in `errors`.
- **`package-identity-mismatch`**: the tarball's own `package.json` names a
  different package or version than the one requested.

A *matching* checksum proves only that the bytes equal what the registry
attests. It says nothing about whether they correspond to the source
repository; that is the job of the source comparison.

The full rule catalog and the scoring weights live with the scanner
(`docs/risk-model.md`). Reserving these IDs here fixes their meaning.

### `scan`

What the scanner covered. A reader must never infer "clean" from a file that
does not appear in the findings, so coverage is explicit.

| Field | Description |
|---|---|
| `performed` | `false` for a report where no scan ran. **Enforced:** then `riskScore` is `null`, `findings` is empty, the verdict is `inconclusive`, and every other field below is empty or zero. |
| `rulesVersion` | Version of the rule set that ran, or `null` |
| `rules` | `{ id, version }` for each rule that ran |
| `filesScanned` | Number of package files that were scanned |
| `filesNotApplicable` | Number of package files that are not scanned by design (images, documents, and similar) |
| `filesSkipped` | Up to 500 `{ path, reason }` entries for files that should have been scanned but were not. `reason` is `too-large`, `over-budget` (the total scan budget was exhausted), `binary` or `unreadable`. |
| `filesSkippedCount` | The true number of skipped files, at least `filesSkipped.length` |
| `capabilityDifferential` | `{ available, basis }`. `basis` says what package behavior was compared with (for example the source files that were read), or why no comparison was possible. **Enforced:** it cannot be available without a resolved source. |

The scanner uses pattern matching, not a parser. It does not understand program
semantics, so obfuscation can evade it, and it can match code that never runs.

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

## Changes from v0.2.0

- `schemaVersion` is `0.3.0`.
- New top-level `scan`; new `summary.scoring`.
- Findings gain `scope`; `fileId` may be `null`; `introducedInPackage` may be
  `null`; evidence gains optional `column` and `indicator`, and `path`/`line`
  may be `null` for package-scope findings.
- `riskScore` is `null` exactly when `scan.performed` is `false` (it was
  "null only with `inconclusive`").
- Enforced verdict rules, two-way finding links, evidence paths that must exist,
  and a reproducible score breakdown.
