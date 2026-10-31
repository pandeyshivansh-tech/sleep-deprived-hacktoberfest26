import { createHash } from 'node:crypto';
import { FetchError, InputError } from '../../errors.js';
import { safeFetchBuffer } from '../../net/safe-fetch.js';
import { encodePackageName, validateSpec } from './spec.js';

const REGISTRY = 'https://registry.npmjs.org';
// Strongest first. SHA-1 is accepted only as a last resort and is called out.
const SRI_ALGORITHMS = Object.freeze(['sha512', 'sha384', 'sha256', 'sha1']);

// Fetches the metadata of one exact version. Never executes anything from it:
// it is untrusted JSON.
export async function fetchVersionMetadata({ name, version, fetchImpl = fetch, limits }) {
  validateSpec({ name, version });
  const url = `${REGISTRY}/${encodePackageName(name)}/${encodeURIComponent(version)}`;

  let body;
  try {
    body = await safeFetchBuffer(url, {
      fetchImpl,
      maxBytes: limits.network.maxMetadataBytes,
      timeoutMs: limits.network.timeoutMs,
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    if (error instanceof FetchError && error.code === 'http' && error.details.status === 404) {
      throw new InputError(`${name}@${version} was not found on the npm registry`, 'not-found');
    }
    throw error;
  }

  let metadata;
  try {
    metadata = JSON.parse(body.toString('utf8'));
  } catch {
    throw new FetchError('The npm registry returned metadata that is not valid JSON', 'bad-metadata');
  }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new FetchError('The npm registry returned unexpected metadata', 'bad-metadata');
  }
  if (metadata.name !== name || metadata.version !== version) {
    throw new FetchError(
      `The npm registry returned metadata for ${metadata.name}@${metadata.version}, not ${name}@${version}`,
      'bad-metadata',
    );
  }
  return metadata;
}

// The tarball URL comes from untrusted metadata, so it goes through the same
// host allowlist as every other request.
export async function fetchTarball({ metadata, fetchImpl = fetch, limits }) {
  const url = metadata.dist?.tarball;
  if (typeof url !== 'string') {
    throw new FetchError('The npm registry metadata has no tarball URL', 'bad-metadata');
  }
  const bytes = await safeFetchBuffer(url, {
    fetchImpl,
    maxBytes: limits.package.maxCompressedBytes,
    timeoutMs: limits.network.timeoutMs,
  });
  return { url, bytes };
}

function parseIntegrityString(text) {
  if (typeof text !== 'string') return [];
  return text
    .split(/\s+/)
    .map((token) => /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})(\?.*)?$/.exec(token))
    .filter(Boolean)
    .map((match) => ({ algorithm: match[1], digest: match[2] }));
}

const digestOf = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('base64');

// Compares the downloaded (or supplied) tarball with the checksum the registry
// publishes. A mismatch is data, not an exception: the caller reports it.
export function checkIntegrity(metadata, bytes) {
  const dist = metadata.dist ?? {};
  const tokens = parseIntegrityString(dist.integrity);
  const chosen = SRI_ALGORITHMS.map((algorithm) => tokens.find((token) => token.algorithm === algorithm)).find(Boolean);

  if (chosen) {
    const actual = `${chosen.algorithm}-${digestOf(chosen.algorithm, bytes)}`;
    const expected = `${chosen.algorithm}-${chosen.digest}`;
    const notes = chosen.algorithm === 'sha1' ? ['The registry publishes only a SHA-1 checksum, which is weak.'] : [];
    return { expected, actual, verified: actual === expected, notes };
  }

  if (typeof dist.shasum === 'string' && /^[0-9a-f]{40}$/i.test(dist.shasum)) {
    const expected = `sha1-${Buffer.from(dist.shasum, 'hex').toString('base64')}`;
    const actual = `sha1-${digestOf('sha1', bytes)}`;
    return {
      expected,
      actual,
      verified: actual === expected,
      notes: ['The registry publishes only a SHA-1 checksum, which is weak.'],
    };
  }

  return {
    expected: null,
    actual: `sha512-${digestOf('sha512', bytes)}`,
    verified: false,
    notes: ['The registry metadata has no checksum, so the tarball could not be verified.'],
  };
}
