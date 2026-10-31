import { buildInventory } from '../archive/inventory.js';
import { readTarGz } from '../archive/tar.js';
import { parseManifest } from '../compare/manifest.js';
import { ArchiveError, FetchError } from '../errors.js';
import { safeFetchBuffer } from '../net/safe-fetch.js';
import { parseRepository } from './repository.js';

const SHA_RE = /^[0-9a-f]{40}$/;
const short = (sha) => sha.slice(0, 12);

function unresolved({ repository = null, directory = null, notes }) {
  return {
    resolved: false,
    repository,
    directory,
    ref: { type: 'none', value: null, commit: null },
    confidence: 'unresolved',
    notes,
    inventory: null,
  };
}

function tagCandidates(name, version) {
  const unscoped = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : null;
  return [...new Set([`v${version}`, version, `${name}@${version}`, unscoped && `${unscoped}@${version}`])].filter(Boolean);
}

const encodeTag = (tag) => tag.split('/').map(encodeURIComponent).join('/').replace(/%40/g, '@');

// Finds the source snapshot for a published version. Order of preference:
//   1. the exact commit npm recorded (gitHead)       -> confidence "exact-commit"
//   2. a tag named after the version                 -> confidence "tag"
//   3. nothing usable                                -> unresolved
// A snapshot is only accepted if its package.json (at the repository
// subdirectory, if any) names the same package. Unresolved is never "clean".
export async function resolveSource({ metadata, name, version, fetchImpl = fetch, limits }) {
  const repo = parseRepository(metadata.repository);
  if (!repo.ok) return unresolved({ notes: [repo.reason] });

  const where = { repository: repo.url, directory: repo.directory };
  const candidates = [];
  const gitHead = typeof metadata.gitHead === 'string' ? metadata.gitHead.toLowerCase() : null;
  if (gitHead && SHA_RE.test(gitHead)) candidates.push({ type: 'gitHead', value: gitHead, path: gitHead });
  for (const tag of tagCandidates(name, version)) {
    candidates.push({ type: 'tag', value: tag, path: `refs/tags/${encodeTag(tag)}` });
  }

  const attempts = [];
  for (const candidate of candidates) {
    const label = candidate.type === 'gitHead' ? `gitHead ${short(candidate.value)}` : `tag "${candidate.value}"`;
    const url = `https://codeload.github.com/${repo.owner}/${repo.repo}/tar.gz/${candidate.path}`;

    let bytes;
    try {
      bytes = await safeFetchBuffer(url, {
        fetchImpl,
        maxBytes: limits.source.maxCompressedBytes,
        timeoutMs: limits.network.timeoutMs,
      });
    } catch (error) {
      if (error instanceof FetchError && error.code === 'http' && error.details.status === 404) {
        attempts.push(`${label}: not found`);
        continue;
      }
      if (error instanceof FetchError) {
        return unresolved({ ...where, notes: [...attempts, `Could not download the source archive for ${label}: ${error.message}`] });
      }
      throw error;
    }

    let parsed;
    let inventory;
    try {
      parsed = await readTarGz(bytes, limits.source);
      inventory = buildInventory(parsed, { directory: repo.directory, limits: limits.source });
    } catch (error) {
      if (error instanceof ArchiveError) {
        return unresolved({ ...where, notes: [...attempts, `The source archive for ${label} was rejected: ${error.message}`] });
      }
      throw error;
    }

    const manifestEntry = inventory.files.get('package.json');
    const { manifest, error: manifestError } = parseManifest(manifestEntry?.data ?? null);
    const where_ = repo.directory ? ` in "${repo.directory}"` : '';
    if (manifestError) {
      attempts.push(`${label}: package.json${where_} could not be verified (${manifestError})`);
      continue;
    }
    if (manifest.name !== name) {
      attempts.push(`${label}: package.json${where_} is named ${JSON.stringify(manifest.name)}, not ${JSON.stringify(name)}`);
      continue;
    }

    const commit = SHA_RE.test(parsed.globalComment ?? '') ? parsed.globalComment : candidate.type === 'gitHead' ? candidate.value : null;
    const notes = [];
    if (candidate.type === 'gitHead') {
      notes.push(`Resolved the exact commit that npm recorded for this release (gitHead ${short(candidate.value)}).`);
    } else {
      if (gitHead) notes.push(`The recorded gitHead could not be used (${attempts.join('; ')}), so a version tag was used instead.`);
      else notes.push('npm recorded no gitHead for this release, so a version tag was used.');
      notes.push(
        `Matched tag "${candidate.value}"${commit ? ` (commit ${short(commit)})` : ''}. A tag is not proof that this is the commit that was published.`,
      );
    }
    if (repo.directory) notes.push(`Compared against the repository subdirectory "${repo.directory}".`);
    notes.push('The source package.json name matches the published package.');
    if (manifest.version === version) {
      notes.push('The source package.json version matches the published version.');
    } else {
      notes.push(
        `The source package.json version is ${JSON.stringify(manifest.version)}, not ${JSON.stringify(version)} (some release processes only set the version at publish time).`,
      );
    }

    return {
      resolved: true,
      repository: repo.url,
      directory: repo.directory,
      ref: { type: candidate.type, value: candidate.value, commit },
      confidence: candidate.type === 'gitHead' ? 'exact-commit' : 'tag',
      notes,
      inventory,
    };
  }

  return unresolved({
    ...where,
    notes: [`No matching source snapshot was found in ${repo.url}. Tried: ${attempts.join('; ')}`],
  });
}
