import { posix } from 'node:path';
import { decodeText, findComments, inComment } from '../scan/text.js';
import { describeMap, generatedLineCount, mightBeSourceMap, readSourceMap, referencedMapPath } from './source-map.js';

// The build-artifact explainer: for each file that differs from the source,
// decide from EVIDENCE whether it is explained, and say what the evidence is.
//
//   source map     a file whose content is a version-3 source map, with embedded
//                  sources that are byte-identical to repository files
//   generated file a file that references such a map (sourceMappingURL), when the
//                  map describes all of its lines
//   type entry     the file package.json declares as its types entry, that looks
//                  like declarations only and has a source file with the same stem
//   publish metadata  package.json differing only by added fields that change
//                  nothing that is installed or run
//   not published  a repository file left out by an explicit `files` list
//
// There is no list of file names or extensions: every rule starts from content or
// from a field the package itself declares. An explanation never exempts a file
// from the security scanner, which runs independently on everything.
//
// Anything the evidence does not cover is `unexplained` (evidence was looked
// for and not found), and a forged or inconsistent map is `unexplained` too.

// package.json fields that change what is installed, run or loaded. A difference
// in any of them is never "publish metadata". (A list of manifest fields, not of
// file names; it errs toward "unexplained".)
const BEHAVIOR_FIELDS = new Set([
  'scripts', 'bin', 'main', 'module', 'browser', 'exports', 'imports', 'files', 'types', 'typings', 'type',
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
  'bundledDependencies', 'bundleDependencies', 'overrides', 'workspaces', 'os', 'cpu', 'engines', 'config',
  'directories', 'man', 'gypfile', 'publishConfig', 'name', 'version',
]);

const MAX_SHOWN = 3;
const GLOB = /[*?[\]{}!]/;

const explained = (category, confidence, evidence) => ({ category, confidence, evidence });
const unexplained = (evidence) => explained('unexplained', 'medium', evidence);

const topField = (field) => field.split('.')[0];
const clean = (path) => posix.normalize(path.replace(/^\.\//, ''));
const stemOf = (path) => posix.basename(path).split('.')[0];

// Paths the package itself declares as entry points, with the field that names them.
function declaredEntries(manifest) {
  const entries = new Map();
  const add = (path, field) => {
    if (typeof path !== 'string' || path === '' || path.startsWith('/') || path.includes('..')) return;
    const key = clean(path);
    entries.set(key, [...(entries.get(key) ?? []), field]);
  };
  const walk = (value, field, depth) => {
    if (typeof value === 'string') add(value, field);
    else if (value && typeof value === 'object' && depth < 6) for (const [key, inner] of Object.entries(value)) walk(inner, `${field}.${key}`, depth + 1);
  };
  for (const field of ['main', 'module', 'browser', 'types', 'typings', 'unpkg', 'jsdelivr', 'bin', 'exports']) {
    if (manifest?.[field] !== undefined) walk(manifest[field], field, 0);
  }
  return entries;
}

// Declaration-shaped: nothing executable at the top level. Deliberately strict;
// a file that fails this is simply not explained as a declaration file.
const DECLARATION_START = /^(?:export|declare|import|interface|type|namespace|module|enum|abstract|const enum)\b|^[}\])]|^\/\/\//;
const EXECUTABLE = /\b(?:eval|Function|require|process|child_process|fetch|XMLHttpRequest|atob)\s*[(.]|\)\s*\{|=\s*function\b|=>\s*\{/;

function looksLikeDeclarations(text) {
  const comments = findComments(text);
  let depth = 0;
  let statements = 0;
  let offset = 0;
  for (const line of text.split('\n')) {
    const start = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (trimmed === '' || inComment(comments, start + (line.length - line.trimStart().length))) continue;
    if (EXECUTABLE.test(trimmed)) return false;
    if (depth === 0) {
      if (!DECLARATION_START.test(trimmed)) return false;
      statements += 1;
    }
    for (const char of trimmed) {
      if (char === '{' || char === '(' || char === '[') depth += 1;
      else if (char === '}' || char === ')' || char === ']') depth = Math.max(0, depth - 1);
    }
  }
  return statements > 0;
}

function explainManifest({ manifest, entry }) {
  if (!manifest.compared) return null;
  if (manifest.changes.length === 0) return null;
  const onlyAdded = manifest.changes.every((change) => change.change === 'added');
  const touched = manifest.changes.filter((change) => BEHAVIOR_FIELDS.has(topField(change.field)));
  if (onlyAdded && touched.length === 0) {
    return explained('publish-normalization', 'medium', [
      `package.json differs only by fields added at publish time (${manifest.changes.map((c) => c.field).slice(0, MAX_SHOWN).join(', ')}), none of which changes what is installed, run or loaded.`,
    ]);
  }
  const why = touched.length > 0 ? `it changes ${touched.map((c) => c.field).slice(0, MAX_SHOWN).join(', ')}, which affects what is installed or run` : 'fields were changed or removed, not only added';
  return unexplained([`package.json is not explained as publish metadata: ${why}.`]);
}

// Sorted so results never depend on archive order.
const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function explainDifferences({ comparison, packageInventory, sourceInventory, manifest, publishedManifest }) {
  const result = new Map();
  if (!sourceInventory || !packageInventory) return result;

  const byHash = new Map();
  for (const record of sourceInventory.files.values()) {
    if (record.type === 'file') byHash.set(record.sha256, [...(byHash.get(record.sha256) ?? []), record.path]);
  }
  const source = { files: sourceInventory.files, byHash };
  const entries = declaredEntries(publishedManifest);
  const sourceStems = new Map();
  for (const record of sourceInventory.files.values()) {
    if (record.type === 'file') sourceStems.set(stemOf(record.path), [...(sourceStems.get(stemOf(record.path)) ?? []), record.path]);
  }

  // Source maps by content, wherever they are in the package.
  const maps = new Map();
  for (const [path, record] of packageInventory.files) {
    if (record.type !== 'file' || !record.data || record.data.length > 8 * 1024 * 1024) continue;
    const text = decodeText(record.data);
    if (text === null || !mightBeSourceMap(text)) continue;
    const map = readSourceMap(text, path, source);
    if (map) maps.set(path, map);
  }

  const differing = comparison.filter((entry) => entry.status === 'modified' || entry.status === 'package-only').sort((a, b) => byPath(a.path, b.path));
  for (const entry of differing) {
    const { path } = entry;
    const record = packageInventory.files.get(path);

    if (path === 'package.json') {
      const verdict = explainManifest({ manifest, entry });
      if (verdict) result.set(path, verdict);
      continue;
    }

    // 1. the file is itself a source map
    const own = maps.get(path);
    if (own) {
      if (own.invalid) result.set(path, unexplained([`Source map ${own.invalid}.`]));
      else if (own.mismatched.length > 0) {
        result.set(path, unexplained([
          ...describeMap(own),
          `${own.mismatched.length} embedded source(s) differ from the repository file at the same path (${own.mismatched.slice(0, MAX_SHOWN).map((m) => m.repoPath).join(', ')}): this map does not describe the repository's source.`,
        ]));
      } else if (own.strength) {
        result.set(path, explained('generated-artifact', own.strength, own.strength === 'high' ? describeMap(own) : [...describeMap(own), 'No source content is embedded, so this is weaker evidence than a byte-identical match.']));
      } else result.set(path, unexplained([`Source map (version 3) listing ${own.sourceCount} source(s), none of which corresponds to a repository file.`]));
      continue;
    }

    const text = record?.type === 'file' && record.data ? decodeText(record.data) : null;

    // 2. the file references a source map that describes it
    const referenced = text ? referencedMapPath(text, path) : null;
    if (referenced) {
      const map = maps.get(referenced);
      if (!map || map.invalid) {
        result.set(path, unexplained([`References ${referenced} as its source map, but that file is not a usable source map in the package.`]));
        continue;
      }
      if (map.mismatched.length > 0 || !map.strength) {
        result.set(path, unexplained([`References source map ${referenced}, which does not describe the repository's source.`]));
        continue;
      }
      const lines = generatedLineCount(text);
      if (lines > map.mappedLines + 1) {
        result.set(path, unexplained([`References source map ${referenced}, but the file has ${lines} line(s) and the map describes only ${map.mappedLines}: the extra lines are not accounted for.`]));
        continue;
      }
      if (map.file && map.file !== posix.basename(path)) {
        result.set(path, unexplained([`References source map ${referenced}, which says it describes ${map.file}, not ${posix.basename(path)}.`]));
        continue;
      }
      const roles = entries.get(path);
      result.set(path, explained('generated-artifact', map.strength, [
        `References source map ${referenced} (sourceMappingURL), which describes all ${lines} line(s) of this file.`,
        ...describeMap(map),
        ...(roles ? [`Declared by package.json as: ${roles.slice(0, MAX_SHOWN).join(', ')}.`] : []),
      ]));
      continue;
    }

    // 3. a declarations-only file that package.json declares as its types entry
    const roles = entries.get(path) ?? [];
    const asTypes = roles.filter((field) => /^(?:types|typings)\b|(?:^|\.)types$/.test(field));
    if (asTypes.length > 0 && text !== null) {
      const stem = stemOf(path);
      const counterparts = (sourceStems.get(stem) ?? []).filter((candidate) => candidate !== path).sort(byPath);
      if (counterparts.length > 0 && looksLikeDeclarations(text)) {
        result.set(path, explained('generated-artifact', 'medium', [
          `Declared by package.json as ${asTypes[0]} and contains only declarations (nothing executable at the top level).`,
          `The repository has source with the same name: ${counterparts.slice(0, MAX_SHOWN).join(', ')}.`,
        ]));
        continue;
      }
    }

    result.set(path, unexplained([
      'No evidence ties this file to the repository: it is not a source map that matches repository source, references no such map, and is not a declarations-only types entry with matching source.',
      ...(roles.length > 0 ? [`package.json declares it as ${roles.slice(0, MAX_SHOWN).join(', ')}, but an entry point alone does not explain a file.`] : []),
    ]));
  }

  // Repository files that were left out on purpose, when package.json says so.
  const files = publishedManifest?.files;
  if (Array.isArray(files) && files.every((item) => typeof item === 'string' && !GLOB.test(item) && !item.startsWith('!'))) {
    const listed = files.map((item) => clean(item).replace(/\/$/, ''));
    for (const entry of comparison.filter((e) => e.status === 'source-only')) {
      const covered = listed.some((item) => entry.path === item || entry.path.startsWith(`${item}/`));
      if (!covered) {
        result.set(entry.path, explained('not-published', 'high', [
          `package.json "files" lists only ${listed.slice(0, MAX_SHOWN).join(', ')}${listed.length > MAX_SHOWN ? ', ...' : ''}; this repository file is not covered, so npm does not publish it.`,
        ]));
      }
    }
  }
  return result;
}
