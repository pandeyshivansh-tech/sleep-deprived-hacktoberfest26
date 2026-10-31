import { SCAN_LIMITS } from '../limits.js';
import { MAX_SKIPPED_LISTED } from '../report/schema.js';
import { categorize, isToolingPath, nativeFormat } from './categorize.js';
import { capabilitiesOf, findIndicators } from './indicators.js';
import { RULES, RULE_LIST } from './rules/index.js';
import { buildLineIndex, decodeText } from './text.js';

export const RULES_VERSION = 'm2-1';

// What behavior the reviewed source shows. Built from the source snapshot's code
// files, minus build, test and tooling paths (see isToolingPath). If any source
// code could not be read, the absence of a behavior cannot be established and the
// differential is reported as unavailable instead of guessed.
function sourceCapabilities(sourceInventory, limits) {
  const capabilities = new Set();
  let read = 0;
  let excluded = 0;
  let unread = 0;
  let bytes = 0;
  for (const [path, record] of [...sourceInventory.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (record.type !== 'file') continue;
    const category = categorize(path, record.head);
    if (category !== 'code') continue;
    if (isToolingPath(path)) {
      excluded += 1;
      continue;
    }
    if (!record.data || record.size > limits.maxFileBytes || bytes + record.size > limits.maxTotalBytes) {
      unread += 1;
      continue;
    }
    const text = decodeText(record.data);
    if (text === null) continue;
    bytes += record.size;
    read += 1;
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    for (const capability of capabilitiesOf(findIndicators(text, { category, extension }).hits)) capabilities.add(capability);
  }
  return { capabilities, read, excluded, unread };
}

function describeDifferential({ sourceResolved, sourceInventory, source, directory }) {
  if (!sourceResolved || !sourceInventory) {
    return { available: false, basis: 'No source snapshot was resolved, so no behavior could be compared with the source.' };
  }
  if (source.unread > 0) {
    return {
      available: false,
      basis: `${source.unread} source code file(s) could not be read within the size and budget limits, so the absence of a behavior in the source cannot be established.`,
    };
  }
  const where = directory ? ` (subdirectory ${directory})` : '';
  return {
    available: true,
    basis: `Behavior in the package was compared with ${source.read} code file(s) of the resolved source snapshot${where}; ${source.excluded} test or tooling file(s) were not counted.`,
  };
}

// The deterministic scanner. Pure: it reads the inventories it is given and
// returns findings and coverage. It never executes, imports or evaluates
// anything from the package, and has no clock, randomness or I/O.
//
// Returns { findings, coverage }. `findings` have no ids yet (the report builder
// numbers them after sorting); `coverage` is the report's `scan` section.
export function scanPackage({
  packageInventory,
  sourceInventory = null,
  sourceResolved,
  comparison,
  manifest,
  integrity,
  identity = null,
  input,
  publishedManifest = null,
  limits = SCAN_LIMITS,
  directory = null,
}) {
  const entries = new Map(comparison.map((entry) => [entry.path, entry]));
  const statusOf = (path) => entries.get(path)?.status ?? 'package-only';

  const source = sourceResolved && sourceInventory ? sourceCapabilities(sourceInventory, limits) : { capabilities: new Set(), read: 0, excluded: 0, unread: 0 };
  const differential = describeDifferential({ sourceResolved, sourceInventory, source, directory });

  const textFiles = [];
  const nativeFiles = [];
  const links = [];
  const skipped = [];
  let scanned = 0;
  let notApplicable = 0;
  let scannedBytes = 0;

  for (const [path, record] of [...packageInventory.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const status = statusOf(path);
    if (record.type !== 'file') {
      links.push({ path, record, status });
      scanned += 1;
      continue;
    }
    const category = categorize(path, record.head);
    if (category === 'other') {
      notApplicable += 1;
      continue;
    }
    if (category === 'native') {
      nativeFiles.push({ path, record, status, category, format: nativeFormat(record.head) });
      scanned += 1;
      continue;
    }
    if (record.size > limits.maxFileBytes) {
      skipped.push({ path, reason: 'too-large' });
      continue;
    }
    if (!record.data || scannedBytes + record.size > limits.maxTotalBytes) {
      skipped.push({ path, reason: 'over-budget' });
      continue;
    }
    const text = decodeText(record.data);
    if (text === null) {
      skipped.push({ path, reason: 'binary' });
      continue;
    }
    scannedBytes += record.size;
    scanned += 1;
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const { hits } = findIndicators(text, { category, extension });
    textFiles.push({
      path,
      category,
      extension,
      status,
      record,
      text,
      lineStarts: buildLineIndex(text),
      hits,
      capabilities: capabilitiesOf(hits),
    });
  }

  const context = {
    sourceResolved,
    differential,
    sourceCapabilities: source.capabilities,
    manifest,
    entries,
    files: new Map(textFiles.map((file) => [file.path, file])),
    integrity,
    identity,
    input,
    publishedManifest,
  };

  const findings = [];
  const manifestFile = textFiles.find((file) => file.path === 'package.json') ?? null;
  for (const rule of RULES) {
    if (rule.kind === 'file') {
      for (const file of textFiles) if (rule.appliesTo(file)) findings.push(...rule.run(file, context));
      for (const file of nativeFiles) if (rule.appliesTo(file)) findings.push(...rule.run(file, context));
    } else if (rule.kind === 'link') {
      for (const link of links) findings.push(...rule.run(link, context));
    } else if (rule.kind === 'manifest') {
      findings.push(...rule.run(manifestFile, context));
    } else if (rule.kind === 'package') {
      findings.push(...rule.run(context));
    }
  }

  return {
    findings,
    coverage: {
      performed: true,
      rulesVersion: RULES_VERSION,
      rules: RULE_LIST.map((rule) => ({ ...rule })),
      filesScanned: scanned,
      filesNotApplicable: notApplicable,
      filesSkipped: skipped.slice(0, MAX_SKIPPED_LISTED),
      filesSkippedCount: skipped.length,
      capabilityDifferential: differential,
    },
  };
}
