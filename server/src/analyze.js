import { buildInventory } from './archive/inventory.js';
import { readTarGz } from './archive/tar.js';
import { compareInventories } from './compare/diff.js';
import { installScriptsOf, diffManifests, parseManifest } from './compare/manifest.js';
import { checkIntegrity, fetchTarball, fetchVersionMetadata } from './ecosystems/npm/registry.js';
import { validateSpec } from './ecosystems/npm/spec.js';
import { ArchiveError, InputError } from './errors.js';
import { DEFAULT_LIMITS } from './limits.js';
import { buildReport } from './report/build.js';
import { retainPackageFile } from './scan/categorize.js';
import { scanPackage } from './scan/index.js';
import { resolveSource } from './source/resolve.js';

async function inspectArchive(bytes, limits) {
  const parsed = await readTarGz(bytes, limits);
  return buildInventory(parsed, { limits, retain: retainPackageFile });
}

function manifestOf(inventory) {
  return parseManifest(inventory?.files.get('package.json')?.data ?? null);
}

// The deterministic core: npm registry (or a supplied tarball) vs the source
// repository. It never executes package code, installs anything, or writes
// package contents to disk, and it uses no AI.
//
// Returns { report, analysis }. `report` follows docs/report-schema.md;
// `analysis` keeps the in-memory inventories for later stages.
export async function analyzeNpmPackage({
  name,
  version,
  tarballBytes = null,
  fetchImpl = fetch,
  limits = DEFAULT_LIMITS,
  now = () => new Date(),
  onProgress = () => {},
}) {
  const errors = [];

  // A supplied tarball may identify itself; the registry spec is then taken
  // from its (untrusted) package.json and validated like any other input.
  let suppliedInventory = null;
  let suppliedError = null;
  if (tarballBytes) {
    try {
      suppliedInventory = await inspectArchive(tarballBytes, limits.package);
    } catch (error) {
      if (!(error instanceof ArchiveError)) throw error;
      suppliedError = error;
    }
    if (!name || !version) {
      const { manifest } = manifestOf(suppliedInventory);
      if (!manifest) {
        throw new InputError(
          `The supplied tarball cannot be identified${suppliedError ? ` (${suppliedError.message})` : ''}. Pass the package name and version explicitly.`,
          'unidentifiable-tarball',
        );
      }
      ({ name, version } = { name: manifest.name, version: manifest.version });
    }
  }
  validateSpec({ name, version });

  onProgress(`Fetching npm metadata for ${name}@${version}`);
  const metadata = await fetchVersionMetadata({ name, version, fetchImpl, limits });

  let bytes = tarballBytes;
  let tarballUrl = null;
  if (!bytes) {
    onProgress('Downloading the published tarball');
    ({ bytes, url: tarballUrl } = await fetchTarball({ metadata, fetchImpl, limits }));
  }

  const integrity = checkIntegrity(metadata, bytes);

  let packageInventory = suppliedInventory;
  if (!tarballBytes) {
    try {
      onProgress('Reading the published tarball (in memory)');
      packageInventory = await inspectArchive(bytes, limits.package);
    } catch (error) {
      if (!(error instanceof ArchiveError)) throw error;
      errors.push({ stage: 'package-archive', message: `The published tarball was rejected: ${error.message}` });
    }
  } else if (suppliedError) {
    errors.push({ stage: 'package-archive', message: `The supplied tarball was rejected: ${suppliedError.message}` });
  }

  // A checksum mismatch and a tarball that names another package are findings when
  // the scanner runs (it only runs on a readable archive). Otherwise, or when the
  // registry published no checksum to compare with, they are listed here.
  if (!integrity.verified && (!packageInventory || !integrity.expected)) {
    errors.push({
      stage: 'integrity',
      message: integrity.expected
        ? 'The tarball does not match the checksum the npm registry publishes for this version.'
        : 'The npm registry publishes no checksum for this version, so the tarball could not be verified.',
    });
  }
  for (const note of integrity.notes) if (integrity.verified) errors.push({ stage: 'integrity', message: note });

  const publishedManifest = manifestOf(packageInventory);
  if (packageInventory && publishedManifest.error) {
    errors.push({ stage: 'package-manifest', message: `The tarball's ${publishedManifest.error}.` });
  }
  const identity = publishedManifest.manifest
    ? { expected: { name, version }, actual: { name: publishedManifest.manifest.name, version: publishedManifest.manifest.version } }
    : null;

  let source;
  if (packageInventory) {
    onProgress('Resolving the source repository snapshot');
    source = await resolveSource({ metadata, name, version, fetchImpl, limits });
  } else {
    source = {
      resolved: false,
      repository: null,
      directory: null,
      ref: { type: 'none', value: null, commit: null },
      confidence: 'unresolved',
      notes: ['The package archive was rejected, so no source comparison was attempted.'],
      inventory: null,
    };
  }

  let comparison = [];
  let manifest;
  if (packageInventory && source.resolved) {
    onProgress('Comparing files and package.json');
    comparison = compareInventories(packageInventory, source.inventory);
    manifest = diffManifests({
      packageData: packageInventory.files.get('package.json')?.data ?? null,
      sourceData: source.inventory.files.get('package.json')?.data ?? null,
    });
  } else {
    // Without a source snapshot nothing can be compared: list what was published.
    comparison = [...(packageInventory?.files.values() ?? [])]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((record) => ({ path: record.path, status: 'package-only', package: record, source: null }));
    manifest = {
      compared: false,
      reason: 'No source snapshot was resolved, so package.json could not be compared.',
      changes: [],
      installScripts: { package: installScriptsOf(publishedManifest.manifest), source: {} },
    };
  }

  const input = { ecosystem: 'npm', name, version, source: tarballBytes ? 'tarball' : 'registry' };

  // The scanner needs a readable package. It never executes or installs anything.
  let scanResult = null;
  if (packageInventory) {
    onProgress('Scanning the published files');
    scanResult = scanPackage({
      packageInventory,
      sourceInventory: source.inventory,
      sourceResolved: source.resolved,
      comparison,
      manifest,
      integrity,
      identity,
      input,
      publishedManifest: publishedManifest.manifest ?? null,
      directory: source.directory,
    });
  }

  const report = buildReport({
    input,
    metadata,
    tarballUrl,
    integrity,
    packageInventory,
    source,
    comparison,
    manifest,
    scanResult,
    errors,
    now,
  });

  return {
    report,
    analysis: { metadata, packageInventory, sourceInventory: source.inventory, comparison, manifest, scanResult },
  };
}
