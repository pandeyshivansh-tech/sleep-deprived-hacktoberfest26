import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeNpmPackage } from '../src/analyze.js';
import { compareInventories } from '../src/compare/diff.js';
import { diffManifests, parseManifest } from '../src/compare/manifest.js';
import { explainDifferences } from '../src/explain/index.js';
import { mightBeSourceMap, readSourceMap, resolveSourcePath } from '../src/explain/source-map.js';
import { validateReport } from '../src/report/schema.js';
import { retainPackageFile } from '../src/scan/categorize.js';
import { inventoryFrom, manifestWith } from '../test-support/scan-fixture.js';
import { FIXED_NOW, makeScenario, manifest as scenarioManifest } from '../test-support/scenario.js';

const TS = 'export default function add(a: number, b: number) { return a + b; }\n';
const map = (extra = {}) => JSON.stringify({ version: 3, file: 'index.js', sources: ['../src/index.ts'], sourcesContent: [TS], mappings: 'AAAA;AACA', names: [], ...extra });
const REF = '\n//# sourceMappingURL=index.js.map\n';
const BUILT = 'export default function add(a,b){return a+b}\n';

// Runs the explainer on in-memory packages exactly as the pipeline would.
function explain({ pkg, src = { 'src/index.ts': TS }, pkgManifest = {}, srcManifest = {} }) {
  const packageInventory = inventoryFrom({ 'package.json': manifestWith(pkgManifest), ...pkg });
  const sourceInventory = inventoryFrom({ 'package.json': manifestWith(srcManifest), ...src });
  const comparison = compareInventories(packageInventory, sourceInventory);
  const manifest = diffManifests({ packageData: packageInventory.files.get('package.json').data, sourceData: sourceInventory.files.get('package.json').data });
  const publishedManifest = parseManifest(packageInventory.files.get('package.json').data).manifest;
  return explainDifferences({ comparison, packageInventory, sourceInventory, manifest, publishedManifest });
}

const category = (result, path) => result.get(path)?.category;
const evidence = (result, path) => (result.get(path)?.evidence ?? []).join(' | ');

// ---------------------------------------------------------------------------
// source maps as evidence
// ---------------------------------------------------------------------------

test('a source map whose embedded source is byte-identical to a repository file is high-confidence evidence', () => {
  const result = explain({ pkg: { 'dist/index.js.map': map({ sources: ['../src/index.ts'] }) } });
  const entry = result.get('dist/index.js.map');
  assert.equal(entry.category, 'generated-artifact');
  assert.equal(entry.confidence, 'high');
  assert.match(entry.evidence.join(' '), /byte-identical to repository files: src\/index\.ts/);
});

test('a generated file is explained by the map it references, and the evidence says so', () => {
  const result = explain({
    pkg: { 'dist/index.js': `${BUILT.trimEnd()}${REF}`, 'dist/index.js.map': map() },
    pkgManifest: { main: 'dist/index.js' },
  });
  const entry = result.get('dist/index.js');
  assert.equal(entry.category, 'generated-artifact');
  assert.equal(entry.confidence, 'high');
  assert.match(entry.evidence.join(' '), /References source map dist\/index\.js\.map/);
  assert.match(entry.evidence.join(' '), /byte-identical/);
  assert.match(entry.evidence.join(' '), /Declared by package\.json as: main/);
});

test('maps are recognised by their content, not their name', () => {
  const renamed = explain({ pkg: { 'dist/payload.dat': map() } });
  assert.equal(category(renamed, 'dist/payload.dat'), 'generated-artifact', 'a map with an unrelated name is still a map');

  const notAMap = explain({ pkg: { 'dist/index.js.map': '{"version":3,"hello":"not a map"}' } });
  assert.equal(category(notAMap, 'dist/index.js.map'), 'unexplained', 'a file named .map that is not a source map explains nothing');
  assert.equal(category(explain({ pkg: { 'dist/index.js.map': 'garbage' } }), 'dist/index.js.map'), 'unexplained');
});

test('embedded source is matched by content, whatever path convention the map uses', () => {
  const result = explain({
    pkg: { 'dist/a.js.map': map({ sources: ['webpack://pkg/./totally/different/path.ts'] }) },
  });
  assert.equal(category(result, 'dist/a.js.map'), 'generated-artifact');
  assert.match(evidence(result, 'dist/a.js.map'), /src\/index\.ts/);
});

test('a map with paths but no embedded source is weaker evidence, and says so', () => {
  const result = explain({ pkg: { 'dist/index.js.map': map({ sourcesContent: undefined }) } });
  const entry = result.get('dist/index.js.map');
  assert.equal(entry.category, 'generated-artifact');
  assert.equal(entry.confidence, 'medium');
  assert.match(entry.evidence.join(' '), /content is not embedded/);
  assert.match(entry.evidence.join(' '), /weaker evidence/);
});

test('bundled dependency code in a map neither confirms nor contradicts, next to a real match', () => {
  const result = explain({
    pkg: { 'dist/index.js.map': map({ sources: ['../src/index.ts', '../node_modules/dep/index.js'], sourcesContent: [TS, 'module.exports = 1;'] }) },
  });
  assert.equal(result.get('dist/index.js.map').confidence, 'high');
});

// ---------------------------------------------------------------------------
// adversarial: forged and inconsistent evidence
// ---------------------------------------------------------------------------

test('a forged map whose embedded source differs from the repository is NOT evidence', () => {
  const forged = map({ sourcesContent: ['export default function add() { return evil(); }\n'] });
  const result = explain({ pkg: { 'dist/index.js': `${BUILT.trimEnd()}${REF}`, 'dist/index.js.map': forged } });
  assert.equal(category(result, 'dist/index.js.map'), 'unexplained');
  assert.match(evidence(result, 'dist/index.js.map'), /differ from the repository file at the same path/);
  assert.equal(category(result, 'dist/index.js'), 'unexplained', 'and the file that references it is not explained either');
  assert.match(evidence(result, 'dist/index.js'), /does not describe the repository's source/);
});

test('a valid map copied next to a file with extra lines does not explain those lines', () => {
  const padded = `${BUILT}console.log("extra line 1");\nconsole.log("extra line 2");\nconsole.log("extra line 3");${REF}`;
  const result = explain({ pkg: { 'dist/index.js': padded, 'dist/index.js.map': map({ mappings: 'AAAA' }) } });
  assert.equal(category(result, 'dist/index.js'), 'unexplained');
  assert.match(evidence(result, 'dist/index.js'), /has 4 line\(s\) and the map describes only 1/);
});

test('a reference to a missing file, a non-map, or a map for a different file explains nothing', () => {
  assert.equal(category(explain({ pkg: { 'dist/index.js': `${BUILT}${REF}` } }), 'dist/index.js'), 'unexplained');
  assert.equal(category(explain({ pkg: { 'dist/index.js': `${BUILT}${REF}`, 'dist/index.js.map': 'not json' } }), 'dist/index.js'), 'unexplained');
  const other = explain({ pkg: { 'dist/index.js': `${BUILT}${REF}`, 'dist/index.js.map': map({ file: 'something-else.js' }) } });
  assert.equal(category(other, 'dist/index.js'), 'unexplained');
  assert.match(evidence(other, 'dist/index.js'), /says it describes something-else\.js/);
});

test('map references that point outside the package or off the machine are never followed', () => {
  for (const url of ['../../outside.map', '/etc/passwd', 'http://evil.test/x.map', 'file:///etc/passwd', '..\\\\x.map', 'data:application/json;base64,e30=']) {
    const result = explain({
      pkg: { 'dist/index.js': `${BUILT}//# sourceMappingURL=${url}\n`, 'dist/outside.map': map() },
    });
    assert.equal(category(result, 'dist/index.js'), 'unexplained', url);
  }
});

test('source paths that leave the root or are absolute resolve to nothing and are never opened', () => {
  assert.equal(resolveSourcePath('../../../etc/passwd', 'dist/a.js.map'), null);
  assert.equal(resolveSourcePath('/etc/passwd', 'dist/a.js.map'), null);
  assert.equal(resolveSourcePath('..\\\\..\\\\x', 'dist/a.js.map'), null);
  assert.equal(resolveSourcePath('webpack://name/../../x', 'a.map'), null);
  assert.equal(resolveSourcePath('../src/a.ts', 'dist/a.js.map'), 'src/a.ts');
  assert.equal(resolveSourcePath('webpack://pkg/./src/a.ts', 'a.js.map'), 'src/a.ts');
  const traversing = explain({ pkg: { 'dist/a.js.map': map({ sources: ['../../../etc/passwd', '/etc/shadow'], sourcesContent: undefined }) } });
  assert.equal(category(traversing, 'dist/a.js.map'), 'unexplained');
});

test('an entry point alone does not explain a file', () => {
  const result = explain({ pkg: { 'lib/evil.js': 'run();', 'dist/index.js': 'run();' }, pkgManifest: { main: 'lib/evil.js', module: 'dist/index.js' } });
  assert.equal(category(result, 'lib/evil.js'), 'unexplained');
  assert.match(evidence(result, 'lib/evil.js'), /package\.json declares it as main, but an entry point alone does not explain a file/);
});

test('hostile maps are bounded and never throw', () => {
  const many = JSON.stringify({ version: 3, sources: Array.from({ length: 3000 }, (_, i) => `s${i}.ts`), mappings: '' });
  const bad = [many, '{"version":3,"sources":[1,2,null],"mappings":"A"}', '{"version":3,"sources":[],"mappings":5}', '{"__proto__":{"version":3},"sources":[],"mappings":""}', '[]', 'null', '{"version":"3"}', `{"version":3,"sources":["${'a'.repeat(100_000)}"],"mappings":""}`];
  for (const content of bad) {
    const result = explain({ pkg: { 'dist/x.map': content } });
    assert.equal(category(result, 'dist/x.map'), 'unexplained', content.slice(0, 40));
  }
  assert.match(evidence(explain({ pkg: { 'dist/x.map': many } }), 'dist/x.map'), /lists 3000 sources \(limit 2000\)/);
  assert.equal({}.polluted, undefined);
  assert.equal(mightBeSourceMap('x'.repeat(9 * 1024 * 1024) + '"mappings""sources"'), false, 'oversized files are not parsed');
  assert.equal(readSourceMap('not json', 'a.map', { files: new Map(), byHash: new Map() }), null);
});

// ---------------------------------------------------------------------------
// declaration files, publish metadata, files list
// ---------------------------------------------------------------------------

const DTS = 'export interface Adder {\n  (a: number, b: number): number;\n}\nexport default function add(a: number, b: number): number;\n';

test('a declarations-only types entry with a same-named source file is explained (medium)', () => {
  const result = explain({ pkg: { 'index.d.ts': DTS }, pkgManifest: { types: 'index.d.ts' } });
  const entry = result.get('index.d.ts');
  assert.equal(entry.category, 'generated-artifact');
  assert.equal(entry.confidence, 'medium');
  assert.match(entry.evidence.join(' '), /Declared by package\.json as types and contains only declarations/);
  assert.match(entry.evidence.join(' '), /same name: src\/index\.ts/);
});

test('a types entry is not explained if it contains executable code, or has no matching source', () => {
  for (const code of [
    'export const x = eval(payload);\n',
    'export function f() { return fetch("https://x.test"); }\n',
    'export declare const a: number;\nconst b = require("child_process");\n',
    'run();\n',
    'export default function add(a, b) { return a + b; }\n',
  ]) {
    const result = explain({ pkg: { 'index.d.ts': code }, pkgManifest: { types: 'index.d.ts' } });
    assert.equal(category(result, 'index.d.ts'), 'unexplained', code);
  }
  assert.equal(category(explain({ pkg: { 'other.d.ts': DTS }, pkgManifest: { types: 'other.d.ts' } }), 'other.d.ts'), 'unexplained', 'no source file with that name');
  assert.equal(category(explain({ pkg: { 'index.d.ts': DTS } }), 'index.d.ts'), 'unexplained', 'not declared as the types entry');
});

test('package.json that differs only by added, non-behavioral fields is publish metadata', () => {
  const result = explain({ pkg: {}, pkgManifest: { gitHead: 'abc123', readme: 'x', readmeFilename: 'README.md' } });
  const entry = result.get('package.json');
  assert.equal(entry.category, 'publish-normalization');
  assert.match(entry.evidence.join(' '), /gitHead/);
});

test('package.json changes that affect what is installed or run are never publish metadata', () => {
  for (const [pkgManifest, srcManifest] of [
    [{ scripts: { postinstall: 'node x.js' } }, {}],
    [{ main: 'lib/x.js' }, {}],
    [{ dependencies: { left: '1.0.0' } }, {}],
    [{ gitHead: 'a', bin: { x: 'cli.js' } }, {}],
    [{ gitHead: 'a', exports: './x.js' }, {}],
    [{ description: 'new text' }, { description: 'old text' }],
    [{ gitHead: 'a' }, { keywords: ['x'] }],
    [{ version: '9.9.9' }, {}],
  ]) {
    const result = explain({ pkg: {}, pkgManifest, srcManifest });
    assert.equal(category(result, 'package.json'), 'unexplained', JSON.stringify(pkgManifest));
  }
});

test('"files" explains repository files that npm leaves out, but only for literal entries', () => {
  const result = explain({
    pkg: { 'dist/a.js': 'a' },
    src: { 'src/index.ts': TS, 'dist/a.js': 'a', 'test/a.test.ts': 't', 'docs/readme.md': 'd' },
    pkgManifest: { files: ['dist', 'index.d.ts'] },
  });
  assert.equal(category(result, 'src/index.ts'), 'not-published');
  assert.equal(category(result, 'test/a.test.ts'), 'not-published');
  assert.match(evidence(result, 'test/a.test.ts'), /"files" lists only dist, index\.d\.ts/);
  assert.equal(result.has('dist/a.js'), false, 'a published file is not "not published"');

  const globbed = explain({ pkg: {}, src: { 'src/index.ts': TS, 'test/a.ts': 't' }, pkgManifest: { files: ['dist/**', '!dist/test'] } });
  assert.equal(globbed.has('test/a.ts'), false, 'glob patterns are not interpreted, so nothing is claimed');
});

test('with no unexplained evidence, ordinary differences are "unexplained", never silently expected', () => {
  const result = explain({ pkg: { 'lib/new.js': 'x', 'src/index.ts': 'changed' }, src: { 'src/index.ts': TS } });
  assert.equal(category(result, 'lib/new.js'), 'unexplained');
  assert.equal(category(result, 'src/index.ts'), 'unexplained');
  assert.match(evidence(result, 'lib/new.js'), /No evidence ties this file to the repository/);
});

test('without a source snapshot nothing is explained', () => {
  assert.equal(explainDifferences({ comparison: [], packageInventory: inventoryFrom({ 'a.js': '1' }), sourceInventory: null, manifest: { compared: false, changes: [], installScripts: {} }, publishedManifest: {} }).size, 0);
});

test('results do not depend on archive order', () => {
  const files = { 'dist/index.js': `${BUILT.trimEnd()}${REF}`, 'dist/index.js.map': map(), 'lib/x.js': 'x', 'index.d.ts': DTS };
  const a = explain({ pkg: files, pkgManifest: { types: 'index.d.ts' } });
  const b = explain({ pkg: Object.fromEntries(Object.entries(files).reverse()), pkgManifest: { types: 'index.d.ts' } });
  assert.equal(JSON.stringify([...a].sort()), JSON.stringify([...b].sort()));
});

test('fuzz: random file contents never crash the explainer', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pieces = ['{"version":3,', '"sources":[', '"../src/index.ts"', '],"mappings":"', '"sourcesContent":[null,', '}', '//# sourceMappingURL=', 'index.js.map', '\n', '"', '\\', '[', ']'];
  for (let round = 0; round < 200; round += 1) {
    const text = Array.from({ length: 1 + Math.floor(rand() * 30) }, () => pieces[Math.floor(rand() * pieces.length)]).join('');
    const result = explain({ pkg: { 'dist/index.js': text, 'dist/index.js.map': text, 'index.d.ts': text }, pkgManifest: { types: 'index.d.ts', main: 'dist/index.js' } });
    for (const entry of result.values()) assert.ok(['generated-artifact', 'unexplained', 'publish-normalization', 'not-published'].includes(entry.category));
  }
});

// ---------------------------------------------------------------------------
// retention is by content, and the pipeline end to end
// ---------------------------------------------------------------------------

test('files that look like JSON objects are retained for the explainer; other unread types are not', () => {
  assert.equal(retainPackageFile('dist/a.js.map', Buffer.from('{"version":3')), true);
  assert.equal(retainPackageFile('dist/payload.dat', Buffer.from('  \n{"version":3')), true);
  assert.equal(retainPackageFile('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])), false);
  assert.equal(retainPackageFile('data.bin', Buffer.from('plain text')), false);
});

const builtPackage = (extra = {}) =>
  makeScenario({
    packageFiles: { 'package.json': scenarioManifest({ main: 'dist/index.js', gitHead: 'abc', ...extra.manifest }), 'dist/index.js': `${BUILT.trimEnd()}${REF}`, 'dist/index.js.map': map(), ...extra.pkg },
    sourceFiles: { 'package.json': scenarioManifest({ main: 'dist/index.js' }), 'src/index.ts': TS },
  });

async function run(scenario) {
  return (await analyzeNpmPackage({ name: 'demo-pkg', version: '1.0.0', fetchImpl: scenario.fetchImpl, now: FIXED_NOW })).report;
}

test('pipeline: a fully explained build is expected-differences, with a valid report and no findings', async () => {
  const report = await run(builtPackage());
  assert.deepEqual(validateReport(report), []);
  assert.equal(report.summary.verdict, 'expected-differences');
  assert.equal(report.summary.riskScore, 0);
  const categories = Object.fromEntries(report.files.map((f) => [f.path, f.explanation.category]));
  assert.equal(categories['dist/index.js'], 'generated-artifact');
  assert.equal(categories['dist/index.js.map'], 'generated-artifact');
  assert.equal(categories['package.json'], 'publish-normalization');
  assert.equal(categories['src/index.ts'], 'unclassified', 'source-only files stay unjudged when no "files" list explains them');
  assert.ok(report.files.find((f) => f.path === 'dist/index.js').explanation.evidence.some((e) => /byte-identical/.test(e)));
});

test('pipeline: one unexplained difference keeps the verdict at needs-review', async () => {
  const report = await run(builtPackage({ pkg: { 'lib/extra.js': 'module.exports = 1;' } }));
  assert.equal(report.summary.verdict, 'needs-review');
  assert.equal(report.files.find((f) => f.path === 'lib/extra.js').explanation.category, 'unexplained');
});

test('pipeline: an explained generated file is STILL scanned, and a finding blocks expected-differences', async () => {
  const payload = `${BUILT.trimEnd()} eval(atob("YWxlcnQoMSk="));${REF}`;
  const report = await run(builtPackage({ pkg: { 'dist/index.js': payload } }));
  const file = report.files.find((f) => f.path === 'dist/index.js');
  assert.equal(file.explanation.category, 'generated-artifact', 'the map still describes this file (the line count matches)');
  const finding = report.findings.find((f) => f.ruleId === 'decoded-code-execution');
  assert.ok(finding, 'the scanner is unaffected by the explanation');
  assert.equal(finding.severity, 'high');
  assert.deepEqual(file.findingIds, [finding.id]);
  assert.equal(report.summary.verdict, 'needs-review', 'expected-differences is impossible with a finding');
  assert.ok(report.summary.riskScore >= 15);
  assert.deepEqual(validateReport(report), []);
});

test('pipeline: low-severity findings also block expected-differences', async () => {
  const report = await run(builtPackage({ pkg: { 'dist/index.js': `${BUILT.trimEnd()} var t = process.env.NPM_TOKEN;${REF}` } }));
  assert.ok(report.findings.some((f) => f.severity === 'low'));
  assert.equal(report.summary.verdict, 'needs-review');
});

test('pipeline: a forged map keeps the verdict at needs-review and the files unexplained', async () => {
  const report = await run(builtPackage({ pkg: { 'dist/index.js.map': map({ sourcesContent: ['export default function add() { return evil(); }\n'] }) } }));
  assert.equal(report.summary.verdict, 'needs-review');
  assert.equal(report.files.find((f) => f.path === 'dist/index.js.map').explanation.category, 'unexplained');
});

test('pipeline: an added install script is never "publish metadata", and nothing makes it expected', async () => {
  const report = await run(builtPackage({ manifest: { scripts: { postinstall: 'node dist/index.js' } } }));
  assert.equal(report.files.find((f) => f.path === 'package.json').explanation.category, 'unexplained');
  assert.ok(report.findings.some((f) => f.ruleId === 'install-script-added'));
  assert.notEqual(report.summary.verdict, 'expected-differences');
});

test('pipeline: without a resolved source there is nothing to explain against', async () => {
  const scenario = makeScenario({ gitHead: null, packageFiles: { 'package.json': scenarioManifest({ main: 'dist/index.js' }), 'dist/index.js': BUILT }, sourceFiles: null });
  const report = await run(scenario);
  assert.equal(report.summary.verdict, 'inconclusive');
  assert.ok(report.files.every((f) => f.explanation.category === 'unclassified'));
  assert.match(report.files[0].explanation.evidence[0], /could not be compared/);
});

test('pipeline: the contract allows expected-differences only with every difference explained', async () => {
  const report = await run(builtPackage());
  const broken = structuredClone(report);
  broken.files.find((f) => f.path === 'dist/index.js').explanation.category = 'unexplained';
  assert.ok(validateReport(broken).some((e) => /requires every difference to be explained/.test(e)));
});
