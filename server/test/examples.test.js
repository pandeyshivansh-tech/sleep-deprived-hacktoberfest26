import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { validateReport } from '../src/report/schema.js';

// The committed examples are the product's proof that it works, so they must
// stay valid, tool-generated and tied to the inputs committed beside them.
const examplesUrl = new URL('../../examples/', import.meta.url);

async function exampleDirectories() {
  const entries = await readdir(examplesUrl, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

const read = (directory, file) => readFile(new URL(`${directory}/${file}`, examplesUrl));

test('there are at least a registry example and a local-tarball example', async () => {
  const sources = new Set();
  for (const directory of await exampleDirectories()) {
    sources.add(JSON.parse(await read(directory, 'report.json')).input.source);
  }
  assert.deepEqual([...sources].sort(), ['registry', 'tarball']);
});

test('every example has an input, a README and a report that satisfies the contract', async () => {
  for (const directory of await exampleDirectories()) {
    const report = JSON.parse(await read(directory, 'report.json'));
    assert.deepEqual(validateReport(report), [], directory);
    assert.equal(report.tool.name, 'audyssey', directory);
    assert.equal(report.$comment, undefined, `${directory} must be tool output, not a hand-written sample`);
    JSON.parse(await read(directory, 'input.json'));
    assert.match((await read(directory, 'README.md')).toString(), /^# /, directory);
    assert.match((await read(directory, 'report.txt')).toString(), /^Audyssey report for /, directory);
  }
});

test('examples claim only what the product does today', async () => {
  for (const directory of await exampleDirectories()) {
    const report = JSON.parse(await read(directory, 'report.json'));
    assert.equal(report.summary.verdict, 'inconclusive', directory);
    assert.equal(report.summary.riskScore, null, directory);
    assert.equal(report.ai.status, 'skipped', directory);
    assert.deepEqual(report.ai.runs, [], directory);
    assert.deepEqual(report.findings, [], directory);
  }
});

test('the tampered example matches the tarball committed beside it', async () => {
  const report = JSON.parse(await read('tampered-demo', 'report.json'));
  const tarball = await read('tampered-demo', 'debug-4.4.1-tampered.tgz');
  assert.equal(report.package.integrity.actual, `sha512-${createHash('sha512').update(tarball).digest('base64')}`);
  assert.equal(report.package.integrity.verified, false);

  const files = Object.fromEntries(report.files.map((file) => [file.path, file.status]));
  assert.equal(files['lib/telemetry.min.js'], 'package-only');
  assert.equal(files['package.json'], 'modified');
  assert.equal(files['src/node.js'], 'modified');
  assert.deepEqual(report.manifest.installScripts.package, { postinstall: 'node lib/telemetry.min.js' });
  assert.deepEqual(report.manifest.installScripts.source, {});
  assert.ok(report.manifest.changes.some((c) => c.field === 'scripts.postinstall' && c.change === 'added'));
});

test('the registry examples were verified against the registry checksum and resolved to an exact commit', async () => {
  for (const directory of await exampleDirectories()) {
    const report = JSON.parse(await read(directory, 'report.json'));
    if (report.input.source !== 'registry') continue;
    assert.equal(report.package.integrity.verified, true, directory);
    assert.equal(report.source.confidence, 'exact-commit', directory);
    assert.match(report.source.ref.commit, /^[0-9a-f]{40}$/, directory);
  }
});
