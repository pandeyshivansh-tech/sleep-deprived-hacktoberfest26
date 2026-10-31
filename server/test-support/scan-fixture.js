import { createHash } from 'node:crypto';
import { compareInventories } from '../src/compare/diff.js';
import { diffManifests, parseManifest } from '../src/compare/manifest.js';
import { scanPackage } from '../src/scan/index.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// An inventory built straight from { path: content }, with the same record
// shape the archive reader produces. `links` adds symlink records.
export function inventoryFrom(files, { links = {}, mode = 0o644 } = {}) {
  const records = new Map();
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    records.set(path, { path, type: 'file', size: data.length, mode, sha256: sha256(data), head: Buffer.from(data.subarray(0, 16)), data });
  }
  for (const [path, target] of Object.entries(links)) {
    records.set(path, {
      path,
      type: 'symlink',
      size: Buffer.byteLength(target),
      mode,
      sha256: sha256(Buffer.from(target)),
      linkTarget: target,
      linkEscapes: target.startsWith('/') || target.startsWith('../'),
      head: null,
      data: null,
    });
  }
  return { rootName: 'package', files: records, stats: {} };
}

const OK_INTEGRITY = { expected: 'sha512-AAAA', actual: 'sha512-AAAA', verified: true };
const manifestJson = (text) => parseManifest(Buffer.from(text ?? '{}')).manifest ?? null;

// Runs the real scanner on in-memory packages. `src: null` means the source
// could not be resolved. Everything the pipeline would compute (the diff and the
// package.json comparison) is computed the same way here.
export function runScan({
  pkg,
  src = null,
  links = {},
  integrity = OK_INTEGRITY,
  identity = null,
  input = { ecosystem: 'npm', name: 'demo', version: '1.0.0', source: 'registry' },
  limits,
  srcOptions = {},
}) {
  const withManifest = (files) => ({ 'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }), ...files });
  const packageInventory = inventoryFrom(withManifest(pkg), { links });
  const sourceInventory = src ? inventoryFrom(withManifest(src), srcOptions) : null;
  const sourceResolved = sourceInventory !== null;

  const comparison = sourceResolved
    ? compareInventories(packageInventory, sourceInventory)
    : [...packageInventory.files.values()].sort((a, b) => (a.path < b.path ? -1 : 1)).map((record) => ({ path: record.path, status: 'package-only', package: record, source: null }));
  const manifest = sourceResolved
    ? diffManifests({ packageData: packageInventory.files.get('package.json').data, sourceData: sourceInventory.files.get('package.json')?.data ?? null })
    : { compared: false, reason: 'No source snapshot was resolved.', changes: [], installScripts: { package: diffManifests({ packageData: packageInventory.files.get('package.json').data, sourceData: null }).installScripts.package, source: {} } };

  const result = scanPackage({
    packageInventory,
    sourceInventory,
    sourceResolved,
    comparison,
    manifest,
    integrity,
    identity,
    input,
    publishedManifest: manifestJson(packageInventory.files.get('package.json').data.toString()),
    limits,
  });
  return { ...result, packageInventory, sourceInventory, comparison, manifest };
}

export const ids = (result) => result.findings.map((finding) => finding.ruleId).sort();
export const find = (result, ruleId) => result.findings.filter((finding) => finding.ruleId === ruleId);
export const one = (result, ruleId) => {
  const found = find(result, ruleId);
  if (found.length !== 1) throw new Error(`expected one ${ruleId} finding, got ${found.length}: ${JSON.stringify(ids(result))}`);
  return found[0];
};

export const manifestWith = (extra) => JSON.stringify({ name: 'demo', version: '1.0.0', ...extra });
