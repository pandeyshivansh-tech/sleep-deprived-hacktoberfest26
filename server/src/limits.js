// Resource limits for untrusted input. Exceeding any of them is an analysis
// error that is reported, never a silent truncation.

const MB = 1024 * 1024;

// Published packages are small; the cap is generous but bounded.
export const PACKAGE_ARCHIVE_LIMITS = Object.freeze({
  maxCompressedBytes: 50 * MB,
  maxUncompressedBytes: 250 * MB,
  maxEntries: 20_000,
  maxFileBytes: 50 * MB,
  maxPathLength: 1024,
  maxPathDepth: 40,
  // Legitimate text compresses roughly 3-10x. Only enforced above 1 MB output.
  maxCompressionRatio: 200,
  // File bytes kept in memory for later analysis; everything else is hashed and dropped.
  maxRetainedFileBytes: 1 * MB,
  maxRetainedTotalBytes: 64 * MB,
});

// A source repository snapshot holds tests, docs and fixtures, so it is larger.
export const SOURCE_ARCHIVE_LIMITS = Object.freeze({
  ...PACKAGE_ARCHIVE_LIMITS,
  maxCompressedBytes: 150 * MB,
  maxUncompressedBytes: 600 * MB,
  maxEntries: 100_000,
  maxFileBytes: 100 * MB,
});

export const NETWORK_LIMITS = Object.freeze({
  maxMetadataBytes: 5 * MB,
  timeoutMs: 60_000,
  maxRedirects: 3,
});

export const DEFAULT_LIMITS = Object.freeze({
  package: PACKAGE_ARCHIVE_LIMITS,
  source: SOURCE_ARCHIVE_LIMITS,
  network: NETWORK_LIMITS,
});
