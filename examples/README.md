# Examples

This directory holds real inputs and the **actual outputs** produced by
PackageLens. Nothing here is hand-written or edited after generation.

As of Milestone 0, PackageLens cannot analyze packages yet, so there are no
examples. They will be added as analysis features land.

## Planned layout

Each example gets its own directory:

```
examples/
  <package>@<version>/
    input.json     The exact request given to PackageLens
    report.json    The report PackageLens produced
    report.md      A human-readable rendering of the same report
    README.md      What the example shows and how to reproduce it
```

Planned cases:

- A recent real-world npm release whose differences are expected to be
  legitimate (built output, source maps).
- A deliberately tampered copy of a package, built locally for demonstration,
  with an added install script and obfuscated network code.

Each example records whether AI analysis ran and which local models
(`gemma4:e4b`, `deepseek-r1:8b`) produced its `ai` section.

The illustrative sample in [`docs/report.sample.json`](../docs/report.sample.json)
describes a fictional package to document the report format. It is not an
example output.
