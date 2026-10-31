import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffManifests, parseManifest } from '../src/compare/manifest.js';

const json = (value) => Buffer.from(JSON.stringify(value));
const diff = (pkg, src) => diffManifests({ packageData: json(pkg), sourceData: json(src) });

test('identical manifests produce no changes, even with different key order', () => {
  const result = diff({ name: 'a', version: '1.0.0', scripts: { test: 't', build: 'b' } }, { scripts: { build: 'b', test: 't' }, version: '1.0.0', name: 'a' });
  assert.deepEqual(result, { compared: true, reason: null, changes: [], installScripts: { package: {}, source: {} } });
});

test('reports added, removed and changed fields as sorted dotted paths', () => {
  const result = diff(
    { name: 'a', version: '1.0.1', main: 'dist/index.js', dependencies: { x: '^1', y: '^2' }, gitHead: 'abc' },
    { name: 'a', version: '1.0.0', main: 'src/index.js', dependencies: { x: '^1', z: '^3' }, devDependencies: { vite: '^8' } },
  );
  assert.equal(result.compared, true);
  assert.deepEqual(
    result.changes.map(({ field, change }) => [field, change]),
    [
      ['dependencies.y', 'added'],
      ['dependencies.z', 'removed'],
      ['devDependencies.vite', 'removed'],
      ['gitHead', 'added'],
      ['main', 'changed'],
      ['version', 'changed'],
    ],
  );
  const main = result.changes.find((c) => c.field === 'main');
  assert.equal(main.packageValue, 'dist/index.js');
  assert.equal(main.sourceValue, 'src/index.js');
  const added = result.changes.find((c) => c.field === 'gitHead');
  assert.equal(added.packageValue, 'abc');
  assert.equal(added.sourceValue, null);
});

test('flags an install script that exists only in the published package', () => {
  const result = diff(
    { name: 'a', scripts: { test: 'jest', postinstall: 'node lib/telemetry.min.js' } },
    { name: 'a', scripts: { test: 'jest' } },
  );
  assert.deepEqual(result.changes, [
    { field: 'scripts.postinstall', change: 'added', packageValue: 'node lib/telemetry.min.js', sourceValue: null },
  ]);
  assert.deepEqual(result.installScripts, { package: { postinstall: 'node lib/telemetry.min.js' }, source: {} });
});

test('only install-time scripts are listed as install scripts', () => {
  const result = diff(
    { scripts: { preinstall: 'a', install: 'b', postinstall: 'c', prepare: 'd', test: 'e', prepublishOnly: 'f' } },
    { scripts: {} },
  );
  assert.deepEqual(result.installScripts.package, { preinstall: 'a', install: 'b', postinstall: 'c' });
});

test('detects changes to executable entry points and nested structures', () => {
  const result = diff(
    { bin: { cli: 'bin/evil.js' }, exports: { '.': { import: './a.mjs', require: './b.cjs' } } },
    { bin: { cli: 'bin/cli.js' }, exports: { '.': { import: './a.mjs', require: './b.cjs' } } },
  );
  assert.deepEqual(result.changes.map((c) => c.field), ['bin.cli']);
});

test('truncates very long values', () => {
  const result = diff({ readme: 'x'.repeat(5000) }, {});
  assert.equal(result.changes[0].packageValue.length < 600, true);
  assert.match(result.changes[0].packageValue, /\[truncated\]$/);
});

test('is not compared when either side is missing, malformed or not an object', () => {
  const ok = json({ name: 'a' });
  for (const [packageData, sourceData, expected] of [
    [ok, null, /^source package\.json is missing/],
    [null, ok, /^published package\.json is missing/],
    [ok, Buffer.from('{ not json'), /^source package\.json is not valid JSON/],
    [Buffer.from('[1,2]'), ok, /^published package\.json is not a JSON object/],
  ]) {
    const result = diffManifests({ packageData, sourceData });
    assert.equal(result.compared, false);
    assert.match(result.reason, expected);
    assert.deepEqual(result.changes, []);
  }
});

test('still lists install scripts of a side that parsed when the other did not', () => {
  const result = diffManifests({ packageData: json({ scripts: { postinstall: 'x' } }), sourceData: null });
  assert.equal(result.compared, false);
  assert.deepEqual(result.installScripts.package, { postinstall: 'x' });
});

test('parseManifest tolerates a UTF-8 BOM', () => {
  const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), json({ name: 'a' })]);
  assert.deepEqual(parseManifest(buffer), { manifest: { name: 'a' } });
});

test('treats a prototype-pollution style key as plain data', () => {
  const buffer = Buffer.from('{"__proto__":{"polluted":true},"name":"a"}');
  const result = diffManifests({ packageData: buffer, sourceData: json({ name: 'a' }) });
  assert.equal(result.compared, true);
  assert.equal({}.polluted, undefined);
});
