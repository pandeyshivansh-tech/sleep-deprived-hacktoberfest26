import { InputError } from '../../errors.js';

// Names and versions end up in URLs, so they are validated strictly before any
// request is built. Legacy packages with uppercase letters still exist on npm.
const NAME_PART = '[A-Za-z0-9][A-Za-z0-9._~-]*';
const NAME_RE = new RegExp(`^(?:@${NAME_PART}/)?${NAME_PART}$`);
const MAX_NAME_LENGTH = 214;

// Exact semver 2.0.0 only: no ranges, no dist-tags such as "latest".
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_VERSION_LENGTH = 128;

export function isValidPackageName(name) {
  return typeof name === 'string' && name.length <= MAX_NAME_LENGTH && NAME_RE.test(name);
}

export function isExactVersion(version) {
  return typeof version === 'string' && version.length <= MAX_VERSION_LENGTH && SEMVER_RE.test(version);
}

export function validateSpec({ name, version }) {
  if (!isValidPackageName(name)) {
    throw new InputError(`"${String(name).slice(0, 80)}" is not a valid npm package name`, 'invalid-name');
  }
  if (!isExactVersion(version)) {
    throw new InputError(
      `"${String(version).slice(0, 80)}" is not an exact version. Use a full version such as 1.2.3; ranges and tags like "latest" are not accepted`,
      'invalid-version',
    );
  }
  return { name, version };
}

// "name@1.2.3" or "@scope/name@1.2.3".
export function parseSpec(text) {
  const at = typeof text === 'string' ? text.lastIndexOf('@') : -1;
  if (at <= 0) {
    throw new InputError(
      `"${String(text).slice(0, 80)}" must look like name@1.2.3 (an exact version is required)`,
      'invalid-spec',
    );
  }
  return validateSpec({ name: text.slice(0, at), version: text.slice(at + 1) });
}

// The registry accepts the scope separator percent-encoded.
export function encodePackageName(name) {
  return name.replace('/', '%2F');
}
