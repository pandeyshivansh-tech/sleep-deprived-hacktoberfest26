// Error types for the analysis pipeline. `code` is stable and meant for tests
// and the CLI; `message` is meant for people.

export class AudysseyError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

// The caller asked for something invalid (bad package spec, version not found).
export class InputError extends AudysseyError {}

// A network request was refused, failed or exceeded a limit.
export class FetchError extends AudysseyError {}

// An archive is malformed, hostile or exceeds a limit. These are never skipped:
// the analysis reports them.
export class ArchiveError extends AudysseyError {}
