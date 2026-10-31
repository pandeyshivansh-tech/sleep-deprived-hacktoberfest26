# Audyssey scanner and risk model

Model `audyssey-risk-v1`, rule set `m2-1`. The constants live in
[`server/src/scan/weights.js`](../server/src/scan/weights.js); the rules live in
[`server/src/scan/`](../server/src/scan). The report contract that carries the
results is [`report-schema.md`](report-schema.md).

## What the scanner is, and is not

The scanner reads the files of a published package as **text** and looks for
patterns. It never executes, imports, installs or evaluates anything from the
package, and uses no AI. It has no parser, so it does not understand programs:

- it can **miss** code that is assembled at runtime (`require(["child", "process"].join("_"))`),
  obfuscated beyond its fingerprints, hidden in files over the size limit, in
  binaries, or in languages it does not read;
- it can **match** code that never runs (an error message that mentions `eval(`).

So a low score is never a statement that a package is safe, and the CLI and the
report say so. Audyssey checks that a package **matches its source**; it cannot
vouch for the source itself. Behavior that the reviewed source already shows is
reported without severity (see "Behavior in the source").

## Pipeline

1. Pick the files to read: code (JavaScript, TypeScript, shell, PowerShell, HTML,
   and a few more), documentation (only for text aimed at AI models), and
   `package.json`. Executables are recognised by their first bytes, not their
   name. Everything else (images, source maps, other JSON) is counted as not
   applicable. Files that should be read but cannot be are listed in
   `scan.filesSkipped` with a reason (`too-large`, `over-budget`, `binary`).
2. Find every indicator in each file once (one table, `indicators.js`). Matches
   in comments are ignored, conservatively: see "Evasion" below.
3. Run the rules over the indicators, the `package.json` comparison from the
   package/source diff, and the checksum result.
4. Work out for each finding whether the behavior is new in the package.
5. Sort the findings (strongest first), number them, score them, choose the verdict.

Limits: 8 MB per file and 200 MB per package are scanned. A larger file is
reported as skipped, never ignored.

## Behavior in the source (the capability differential)

For each finding that is about a behavior, Audyssey asks whether the **source
snapshot** shows the same behavior. `introducedInPackage` is:

- `false` when the file is byte-identical to the source, or the source has the
  same behavior in another file;
- `true` when the file differs from the source and the source never shows it;
- `null` (unknown) when there is no source snapshot, or part of it could not be
  read.

A finding with `introducedInPackage: false` is **reported with severity `info`**:
whoever reviewed the source could see it, and it says nothing about the package
differing from it. It still appears, with evidence, and still carries zero points.

The comparison is by **capability class**, and the dangerous variants are classes
of their own, so a harmless form in the source never excuses a dangerous one in
the package:

| Capability | Meaning |
|---|---|
| `dynamic-exec` | `eval`, `Function`, `vm`, string timers |
| `dynamic-exec-computed` | the same, with something other than a string literal |
| `decoded-exec` | decoding data (base64, character codes, decryption) close to running it |
| `process-exec` | `child_process` calls |
| `process-exec-risky` | a command that downloads code, pipes to a shell or is encoded |
| `network` | network modules, `fetch`, `XMLHttpRequest`, WebSocket |
| `secret-env` / `env-enumerate` | secret-named environment variables / listing the whole environment |
| `sensitive-files` | paths of credential, key and wallet files |
| `global-hook` | assigning to `fetch` or `XMLHttpRequest` |

Source files under test, example, documentation, script and tool directories
(and build configuration) are not counted as the source "having" a behavior,
because that code is not what ships. If the scanner misclassifies a path, a
behavior looks *more* new: the error is on the cautious side. If any source
**code** file could not be read, the differential is reported as unavailable
(`introducedInPackage: null`) instead of guessing that a behavior is absent.

## Rules

Severity is how much a finding would matter if it were real. Confidence is how
often the pattern fires on legitimate packages, which is why most pattern rules
are `medium` and only structural fingerprints are `high`.

| Rule | Severity | Confidence | Fires when |
|---|---|---|---|
| `install-script-added` | high | high | `package.json` defines a `preinstall`/`install`/`postinstall` script the source does not |
| `install-script-changed` | high | high | the script differs from the source's |
| `install-script-present` | info (medium without a source) | high (medium) | the script is identical to the source's (info), or there is no source to compare (medium) |
| `install-script-fetches-code` | high | high | the script downloads, pipes to a shell, or is an encoded command |
| `install-script-runs-unsourced-file` | medium | medium | the script runs a file that is new or different in the package (only with a resolved source) |
| `install-script-runs-risky-file` | high | high | the script runs a file that downloads/decodes code, refers to a data-drop service, reads credentials and can send data out, or hooks the network near wallet code |
| `integrity-mismatch` | high | high for a supplied tarball, medium for a download | the analyzed bytes do not match the checksum the registry publishes for this version (package scope) |
| `package-identity-mismatch` | high | high | the tarball's `package.json` names another package or version (package scope) |
| `decoded-code-execution` | high | high | decoding (base64, character codes, `unescape`, `createDecipher`) close to `eval`/`Function`/`vm` |
| `network-hook-wallet-swap` | high | high (medium) | assigning to `fetch`/`XMLHttpRequest` together with `window.ethereum` and wallet addresses (medium if only one wallet signal) |
| `credential-network-combination` | high; critical when obfuscated or hooked and new in the package | medium | one file reads secret-named variables, lists the environment, or reads credential files **and** makes network requests or starts processes |
| `obfuscated-code` | high with encoded data, medium for obfuscator fingerprints (`_0x…` names, a rotated string array), medium for two kinds of encoded data, info for one | high / low | see `indicators.js`. Minified code alone is **not** obfuscation. |
| `process-execution` | low; medium if the command downloads or hides code | medium | `child_process` is imported and a process is started |
| `dynamic-code-execution` | low; medium for computed arguments | medium | `eval`, `Function`, `vm`, string timers (not the `Function('return this')` idiom) |
| `sensitive-file-access` | medium with file reads; low otherwise | medium / low | paths such as `.npmrc`, `.ssh`, browser profiles, wallets |
| `sensitive-env-access` | low; medium for listing every variable | medium | secret-named environment variables |
| `hardcoded-endpoint` | medium for webhook/paste/tunnel services; low for a raw public IP | medium | a URL of that kind |
| `global-network-hook` | medium | low | assigning to `fetch`/`XMLHttpRequest` without wallet signals (polyfills do this) |
| `unexpected-native-binary` | medium; info for WebAssembly, platform-specific packages (`os`/`cpu`) or a file identical to the source | low | an ELF, Mach-O or PE executable (found by magic bytes) |
| `symlink-escapes-root` | medium | high | a symlink or hard link whose target is outside the package |
| `network-access` | info | high | new network use (never listed when the source has it) |
| `llm-directed-text` | low | medium | phrases such as "ignore previous instructions", in code or documentation |

## Weights and why

`points = base × confidence × introduced × repeat`, capped at 100. The report
lists every factor for every finding (`summary.scoring`), and the validator
checks the arithmetic, so a score can be recomputed from the report alone.

| Factor | Values | Why |
|---|---|---|
| Base points | info 0, low 4, medium 12, high 30, critical 55 | Chosen so thresholds cannot be crossed by accident: one high finding (30) reaches `needs-review` (15) but not `suspicious` (60); two distinct high rules (30 + 30) reach exactly 60; a critical finding (55) alone is still below 60; several low findings stay below 15. |
| Confidence | high 1.0, medium 0.7, low 0.4 | A pattern that never fires on legitimate packages counts fully; one that does fire occasionally counts less. |
| Introduced | new 1.0, unknown 0.75, in the source 0.25 | Unknown is less than new, because the source might explain it. In-source behavior is reported at `info`, so its points are zero. |
| Repeat | 1, ½, ¼, … per rule, strongest first | A rule's total can never exceed twice its strongest finding, so repetition cannot inflate a score. |

`critical` is reserved for the correlation rule, and only when the file is also
obfuscated or hooks the network and is new in the package.

## Verdicts

| Verdict | When (in this order) |
|---|---|
| `suspicious` | **at least two distinct rules** produce high or critical findings, **and** the score is at least 60. One indicator, however severe, never produces it. |
| `needs-review` | any finding of medium or above, or a score of at least 15 |
| `inconclusive` | the source is unresolved and nothing above applies. Unresolved is never clean. |
| `expected-differences` | the source is resolved, there are modified or package-only files, **every one of them is explained by the build-artifact explainer** (`generated-artifact` or `publish-normalization`), and nothing of low severity or above was found. |
| `needs-review` | the source is resolved and there are modified or package-only files that are not all explained. |
| `needs-review` | any finding of low severity |
| `no-differences` | the source is resolved, every published file matches it, and nothing of low severity or above was found. Source-only files are not published, so they do not count. |

The contract validator enforces the guarantees behind this table (see
[`report-schema.md`](report-schema.md)): `suspicious` needs two distinct strong
rules, `no-differences` needs a resolved source and nothing of low severity or
above, `inconclusive` never carries a finding of medium or above. So no report
can claim more than its findings allow. `expected-differences` additionally
requires every difference to be explained (see [Explaining differences](#explaining-differences)).
An explanation never lowers a score or hides a finding: the scanner reads every
published file, explained or not, and a single finding of low severity or above
rules `expected-differences` out.

## Explaining differences

The explainer (`server/src/explain/`) decides, from evidence in the package and
the repository, whether a file that differs is a legitimate build artifact. It
has no list of file names or extensions: each rule starts from file content or
from a field the package declares.

| Category | Evidence required |
|---|---|
| `generated-artifact` (source map) | The file's content is a version-3 source map whose embedded `sourcesContent` is byte-identical (SHA-256) to files in the repository: `high`. A map that lists repository paths but embeds no content is `medium`. |
| `generated-artifact` (generated file) | The file ends with a `sourceMappingURL` reference to such a map in the package, the map's `file` field agrees, and the map describes every line of the file. `package.json` entry points are cited when they apply. |
| `generated-artifact` (declarations) | The file is declared by `package.json` as its `types`, contains only declarations (nothing executable at the top level), and the repository has a source file with the same name: `medium`. |
| `publish-normalization` | `package.json` differs only by **added** fields, none of which affects what is installed, run or loaded (scripts, bin, main, exports, dependencies and similar are never normalization). |
| `not-published` | The repository file is not covered by an explicit, glob-free `files` list in `package.json`. |
| `unexplained` | Anything else, including a map whose embedded source *differs* from the repository file (forged or stale), a file whose extra lines the map does not cover, and a file that is only an entry point. |

Limits, stated plainly: build configuration beyond `package.json` (bundler or
`tsconfig` files) is not read; a valid map shows that a file *claims* and
plausibly matches a repository source, not that it equals the compiler's real
output (a line-coverage check catches appended code, not edits within mapped
lines); `.npmignore`/`.gitignore` and glob `files` entries are not interpreted.
These limits are why the scanner still reads explained files and why an
explanation can only help reach `expected-differences`, never override a finding.

## Measured on popular, benign packages

`node server/scripts/scan-corpus.mjs` analyzes 24 popular packages with the full
pipeline (it needs network access and is not part of CI). Result of the last run:

- **0 findings of high or critical severity** in 24 packages.
- 10 `no-differences`, 13 `needs-review`, 1 `inconclusive`.
- Findings of low severity or above appeared in only two packages, both with an
  unresolved source: esbuild (an install script, `child_process`; score 10) and
  puppeteer (an install script; score 6).
- 11 of the 13 `needs-review` verdicts have a score of 0: the package differs
  from its source (built output) and nothing can explain it yet.
- One file over the 8 MB limit (in typescript's bundle) is listed as skipped.

An earlier probe of the raw patterns (before the differential) on 18 of these
packages is what set the confidence levels: `eval(` appeared in 1 package,
`Function(…)` in 3 (all the `return this` idiom), `child_process` in 3, secret-named
environment variables in 3, a run of hex escapes in 1, and minified files in 5.
Minified code is therefore not treated as obfuscation.

## Patterns from public incidents

`server/test/scan-incidents.test.js` runs inert, defanged recreations of attack
**patterns** that public write-ups describe (a bundle that hooks the network
near wallet code, an install script that runs a token-reading file, a preinstall
that downloads and runs a program, an encrypted payload decoded and run) through
the whole pipeline, and asserts which of them reach `suspicious` and which stay
at `needs-review`. They do not show that any specific real package or incident
would be detected.

## Known limits and evasion

- **Runtime assembly and obfuscation** that the fingerprints do not cover.
- **Destructive behavior** (deleting or overwriting files), geofenced payloads
  and time bombs: no rule looks for them.
- **Files over 8 MB, binary payloads and other languages**: reported as skipped
  or not applicable, not inspected.
- **Comments:** a comment is masked only when it begins at the start of a line or
  after `;`, `{`, `}`, `)` or `,`, and never inside a string. A payload placed
  after a fake comment opener (`"/*"`, `/a\//`) is still scanned. Matches inside
  strings are still reported (a regex literal can make a string tracker swallow real
  code, so suppressing them would be an evasion route).
- **Source that is itself malicious** looks the same as a matching package.
- Only npm packages and GitHub-hosted sources.

## Changing the model

A weight or rule change changes what a score means. Update `weights.js`, bump
`MODEL` (and `RULES_VERSION` for rules), update this document, run the corpus
script, and regenerate `examples/`. Contract changes go in their own PR.
