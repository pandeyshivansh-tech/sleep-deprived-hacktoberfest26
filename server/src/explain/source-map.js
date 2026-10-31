import { createHash } from 'node:crypto';
import { posix } from 'node:path';

// Reading source maps as EVIDENCE of where a published file came from. A map is
// untrusted JSON: it is parsed, never executed, and every size is bounded.
// Recognition is by content (a version-3 map with sources and mappings), never
// by file name or extension.

export const MAX_MAP_BYTES = 8 * 1024 * 1024;
const MAX_SOURCES = 2000;
const MAX_SHOWN = 3;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Cheap pre-check so ordinary files are not parsed as JSON.
export const mightBeSourceMap = (text) => text.length <= MAX_MAP_BYTES && text.includes('"mappings"') && text.includes('"sources"');

// Resolves a `sources` entry to a path inside the repository snapshot, or null.
// The map file's own directory is the base (that is how maps are written), a
// URL scheme such as webpack://name/ is dropped, and anything that would leave the
// root or is absolute resolves to nothing. No file is ever opened: the result is
// only a key into the in-memory source inventory.
export function resolveSourcePath(source, mapPath, sourceRoot) {
  const withoutScheme = source.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\//i, '');
  if (withoutScheme.startsWith('/') || withoutScheme.includes('\\') || withoutScheme.includes('\0')) return null;
  const root = typeof sourceRoot === 'string' && !sourceRoot.startsWith('/') ? sourceRoot : '';
  const resolved = posix.normalize(posix.join(posix.dirname(mapPath), root, withoutScheme));
  return resolved === '.' || resolved === '..' || resolved.startsWith('../') ? null : resolved;
}

// Parses a source map and compares what it says with the repository.
//   matched     an embedded source is byte-identical to a repository file
//   mismatched  an embedded source sits at a repository path but differs from it
//               (a forged or stale map: this is NOT evidence of anything good)
//   pathOnly    no embedded source, but the listed path exists in the repository
// Returns null when the text is not a source map.
export function readSourceMap(text, mapPath, source) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(json) || json.version !== 3 || !Array.isArray(json.sources) || typeof json.mappings !== 'string') return null;
  if (json.sources.length > MAX_SOURCES) return { invalid: `lists ${json.sources.length} sources (limit ${MAX_SOURCES})` };

  const contents = Array.isArray(json.sourcesContent) ? json.sourcesContent : [];
  const matched = [];
  const mismatched = [];
  const pathOnly = [];
  for (const [index, entry] of json.sources.entries()) {
    if (typeof entry !== 'string') continue;
    const repoPath = resolveSourcePath(entry, mapPath, json.sourceRoot);
    const atPath = repoPath ? source.files.get(repoPath) : undefined;
    const embedded = contents[index];
    if (typeof embedded === 'string') {
      const owners = source.byHash.get(sha256(embedded));
      if (owners) matched.push({ source: entry, repoPath: owners[0] });
      else if (atPath?.type === 'file') mismatched.push({ source: entry, repoPath });
      // otherwise the source has no counterpart (for example bundled dependency
      // code): it is neither confirmation nor contradiction.
    } else if (atPath?.type === 'file') {
      pathOnly.push({ source: entry, repoPath });
    }
  }

  let strength = null;
  if (mismatched.length === 0) {
    if (matched.length > 0) strength = 'high';
    else if (pathOnly.length > 0) strength = 'medium';
  }
  return {
    sourceCount: json.sources.length,
    matched,
    mismatched,
    pathOnly,
    strength,
    mappedLines: json.mappings.split(';').length,
    file: typeof json.file === 'string' ? json.file : null,
  };
}

const list = (items) => items.slice(0, MAX_SHOWN).join(', ') + (items.length > MAX_SHOWN ? `, and ${items.length - MAX_SHOWN} more` : '');

export function describeMap(map) {
  const bits = [`Source map (version 3) listing ${map.sourceCount} source(s).`];
  if (map.matched.length > 0) {
    bits.push(`${map.matched.length} embedded source(s) are byte-identical to repository files: ${list(map.matched.map((m) => m.repoPath))}.`);
  }
  if (map.pathOnly.length > 0) {
    bits.push(`${map.pathOnly.length} listed source(s) exist in the repository (their content is not embedded, so it was not compared): ${list(map.pathOnly.map((m) => m.repoPath))}.`);
  }
  return bits;
}

// The reference a generated file makes to its map, from the end of the file.
const MAP_REFERENCE = /[#@]\s*sourceMappingURL=([^\s*'"]+)/g;

export function referencedMapPath(text, filePath) {
  const tail = text.slice(-1500);
  let last = null;
  for (const match of tail.matchAll(MAP_REFERENCE)) last = match[1];
  if (!last || /^[a-z][a-z0-9+.-]*:/i.test(last) || last.startsWith('/') || last.includes('\\')) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(filePath), decodeURIComponent(last)));
  return resolved === '..' || resolved.startsWith('../') ? null : resolved;
}

// How many lines the generated file has, ignoring the trailing map reference.
export function generatedLineCount(text) {
  const body = text.replace(/\n?\s*(?:\/\/|\/\*)[#@]\s*sourceMappingURL=[^\n]*\s*$/, '');
  return body.replace(/\n+$/, '').split('\n').length;
}
