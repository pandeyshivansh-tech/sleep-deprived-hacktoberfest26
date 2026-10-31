import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePackageName, isExactVersion, isValidPackageName, parseSpec } from '../src/ecosystems/npm/spec.js';
import { InputError } from '../src/errors.js';

test('parses plain, scoped and prerelease specs', () => {
  assert.deepEqual(parseSpec('debug@4.4.1'), { name: 'debug', version: '4.4.1' });
  assert.deepEqual(parseSpec('@babel/core@7.26.0'), { name: '@babel/core', version: '7.26.0' });
  assert.deepEqual(parseSpec('left-pad@1.3.0-beta.1+build.5'), { name: 'left-pad', version: '1.3.0-beta.1+build.5' });
  assert.deepEqual(parseSpec('JSONStream@1.3.5'), { name: 'JSONStream', version: '1.3.5' });
});

test('requires an exact version', () => {
  for (const bad of ['debug', '@babel/core', 'debug@', 'debug@^4.4.1', 'debug@~4.4', 'debug@latest', 'debug@4', 'debug@4.4', 'debug@>=1.0.0', 'debug@01.2.3', 'debug@1.2.3 ']) {
    assert.throws(() => parseSpec(bad), InputError, bad);
  }
});

test('rejects names that could alter the request URL', () => {
  const bad = ['../etc/passwd', 'a/b', '@scope', '@/pkg', '@scope/', 'a b', 'a?x=1', 'a#frag', 'a%2Fb', '.hidden', '_private', '', 'x'.repeat(215), '@a/b/c', 'a\\b', 'a\nb'];
  for (const name of bad) {
    assert.equal(isValidPackageName(name), false, JSON.stringify(name));
    assert.throws(() => parseSpec(`${name}@1.0.0`), InputError, JSON.stringify(name));
  }
});

test('rejects non-string input', () => {
  assert.throws(() => parseSpec(undefined), InputError);
  assert.throws(() => parseSpec(42), InputError);
  assert.equal(isValidPackageName(null), false);
  assert.equal(isExactVersion(undefined), false);
});

test('encodes the scope separator for the registry URL', () => {
  assert.equal(encodePackageName('@babel/core'), '@babel%2Fcore');
  assert.equal(encodePackageName('debug'), 'debug');
});
