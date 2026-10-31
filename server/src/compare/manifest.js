// Semantic comparison of the published and source package.json files.
// Both files are untrusted JSON: they are parsed, never executed.

const MAX_VALUE_CHARS = 500;
const MAX_FLATTEN_DEPTH = 3;
// Scripts npm runs when a consumer installs from the registry. (A binding.gyp
// implies an implicit install script; that is for the scanner to flag.)
export const INSTALL_SCRIPT_NAMES = Object.freeze(['preinstall', 'install', 'postinstall']);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function capValue(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= MAX_VALUE_CHARS) return value;
  return `${text.slice(0, MAX_VALUE_CHARS)}… [truncated]`;
}

function flatten(value, prefix, out, depth) {
  if (isPlainObject(value) && depth < MAX_FLATTEN_DEPTH && Object.keys(value).length > 0) {
    for (const key of Object.keys(value)) flatten(value[key], prefix ? `${prefix}.${key}` : key, out, depth + 1);
  } else {
    out.set(prefix, value);
  }
}

// Returns { manifest } or { error }.
export function parseManifest(buffer) {
  if (!buffer) return { error: 'package.json is missing or too large to read' };
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''));
  } catch (error) {
    return { error: `package.json is not valid JSON (${error.message})` };
  }
  if (!isPlainObject(parsed)) return { error: 'package.json is not a JSON object' };
  return { manifest: parsed };
}

export function installScriptsOf(manifest) {
  const scripts = {};
  if (!isPlainObject(manifest?.scripts)) return scripts;
  for (const name of INSTALL_SCRIPT_NAMES) {
    if (typeof manifest.scripts[name] === 'string') scripts[name] = capValue(manifest.scripts[name]);
  }
  return scripts;
}

export function diffManifests({ packageData, sourceData }) {
  const packageResult = parseManifest(packageData);
  const sourceResult = parseManifest(sourceData);
  const installScripts = {
    package: installScriptsOf(packageResult.manifest),
    source: installScriptsOf(sourceResult.manifest),
  };

  if (packageResult.error || sourceResult.error) {
    const reasons = [];
    if (packageResult.error) reasons.push(`published ${packageResult.error}`);
    if (sourceResult.error) reasons.push(`source ${sourceResult.error}`);
    return { compared: false, reason: reasons.join('; '), changes: [], installScripts };
  }

  const packageFields = new Map();
  const sourceFields = new Map();
  for (const key of Object.keys(packageResult.manifest)) flatten(packageResult.manifest[key], key, packageFields, 1);
  for (const key of Object.keys(sourceResult.manifest)) flatten(sourceResult.manifest[key], key, sourceFields, 1);

  const changes = [];
  for (const field of [...new Set([...packageFields.keys(), ...sourceFields.keys()])].sort()) {
    const inPackage = packageFields.has(field);
    const inSource = sourceFields.has(field);
    if (inPackage && inSource) {
      if (stable(packageFields.get(field)) === stable(sourceFields.get(field))) continue;
      changes.push({ field, change: 'changed', packageValue: capValue(packageFields.get(field)), sourceValue: capValue(sourceFields.get(field)) });
    } else if (inPackage) {
      changes.push({ field, change: 'added', packageValue: capValue(packageFields.get(field)), sourceValue: null });
    } else {
      changes.push({ field, change: 'removed', packageValue: null, sourceValue: capValue(sourceFields.get(field)) });
    }
  }
  return { compared: true, reason: null, changes, installScripts };
}
