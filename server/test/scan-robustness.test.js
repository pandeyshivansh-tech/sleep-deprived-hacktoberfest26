import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCAN_LIMITS } from '../src/limits.js';
import { findIndicators } from '../src/scan/indicators.js';
import { MAX_SNIPPET_CHARS } from '../src/report/schema.js';
import { runScan } from '../test-support/scan-fixture.js';

const MB = 1024 * 1024;
const timed = (fn) => {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
};

// ---------------------------------------------------------------------------
// Regex backtracking. Every input below is hostile to a careless pattern: long
// runs of characters that a quantifier could split many ways, openers with no
// closer, and anchors repeated thousands of times. Package contents are
// attacker-controlled, so the scanner must stay linear on all of them.
// ---------------------------------------------------------------------------

const PATHOLOGICAL = {
  'one long identifier': 'a'.repeat(1_000_000),
  'only double quotes': '"'.repeat(1_000_000),
  'only single quotes': "'".repeat(1_000_000),
  'comment openers': '/*'.repeat(500_000),
  'line comment openers': '//'.repeat(500_000),
  'env name that never ends': `process.env.${'A'.repeat(1_000_000)}`,
  'env bracket that never closes': `process.env[${"'".repeat(1)}${'A'.repeat(1_000_000)}`,
  'hex escapes without end': '"' + '\\x41'.repeat(250_000),
  'base64-looking string with no closing quote': `"${'A'.repeat(1_000_000)}`,
  'long run of spaces after a keyword': `ignore${' '.repeat(1_000_000)}`,
  'keyword then spaces then paren': `eval${' '.repeat(1_000_000)}(`,
  'fromCharCode list with no end': `String.fromCharCode(${'1,'.repeat(500_000)}`,
  'push/shift with open parens': `['push'](${'('.repeat(200_000)}`,
  'obfuscator loops': 'while(!![]){try{'.repeat(60_000),
  'Function with endless literal arguments': `new Function(${'"a",'.repeat(200_000)}`,
  'hex identifier prefix': `_0x${'a'.repeat(1_000_000)}`,
  'wallet prefix': `0x${'a'.repeat(1_000_000)}`,
  'import with spaces': `require(${' '.repeat(1_000_000)}"child_process")`,
  'nested call parens': 'exec('.repeat(200_000),
  'only newlines': '\n'.repeat(1_000_000),
  'ip-like numbers': 'http://1.1.1.1'.repeat(80_000),
  'backslashes': '\\'.repeat(1_000_000),
  'unterminated template': '`' + '${'.repeat(300_000),
};

test('hostile inputs are scanned in linear time', () => {
  for (const [name, text] of Object.entries(PATHOLOGICAL)) {
    const { ms } = timed(() => runScan({ pkg: { 'a.js': text }, src: { 'src/a.js': 'ok' } }));
    assert.ok(ms < 3000, `${name} took ${Math.round(ms)} ms`);
  }
});

test('the same hostile inputs are fast when searched for indicators directly, in every category', () => {
  for (const [name, text] of Object.entries(PATHOLOGICAL)) {
    for (const category of ['code', 'doc', 'manifest']) {
      const { ms } = timed(() => findIndicators(text, { category, extension: category === 'code' ? 'js' : 'md' }));
      assert.ok(ms < 3000, `${name} (${category}) took ${Math.round(ms)} ms`);
    }
  }
});

test('input that makes matches explode is capped, not enumerated', () => {
  const text = 'eval(x);\n'.repeat(200_000);
  const { value, ms } = timed(() => findIndicators(text, { category: 'code', extension: 'js' }));
  assert.equal(value.hits['exec.eval'].length, SCAN_LIMITS.maxMatchesPerIndicator);
  assert.ok(ms < 3000, `capping took ${Math.round(ms)} ms`);

  const result = runScan({ pkg: { 'a.js': text } });
  const finding = result.findings.find((f) => f.ruleId === 'dynamic-code-execution');
  assert.ok(finding.evidence.length <= SCAN_LIMITS.maxEvidencePerFinding);
  assert.ok(finding.evidence.every((e) => e.snippet.length <= MAX_SNIPPET_CHARS));
});

// ---------------------------------------------------------------------------
// Performance and memory at the approved limits
// ---------------------------------------------------------------------------

function minifiedLine(bytes) {
  const piece = 'var a=function(b,c){return b+c},d="x"+a(1,2);if(typeof window!=="undefined"){d=window.name}';
  return piece.repeat(Math.ceil(bytes / piece.length)).slice(0, bytes);
}

test('a file at the 8 MB cap is scanned, with its patterns found at the right position', () => {
  const body = minifiedLine(8 * MB - 200);
  const text = `${body}\nfunction f(x){return eval(x)}`;
  assert.ok(text.length <= 8 * MB);
  const { value, ms } = timed(() => runScan({ pkg: { 'dist/big.js': text }, src: { 'src/a.js': 'ok' } }));
  assert.ok(ms < 15_000, `scanning 8 MB took ${Math.round(ms)} ms`);
  assert.equal(value.coverage.filesSkippedCount, 0);
  const finding = value.findings.find((f) => f.ruleId === 'dynamic-code-execution');
  assert.equal(finding.evidence[0].line, 2);
});

test('scanning does not hold on to file text between files (bounded memory)', () => {
  const before = process.memoryUsage().rss;
  for (let index = 0; index < 6; index += 1) {
    runScan({ pkg: { [`dist/part${index}.js`]: minifiedLine(4 * MB) }, src: { 'src/a.js': 'ok' } });
  }
  const growth = process.memoryUsage().rss - before;
  assert.ok(growth < 900 * MB, `rss grew by ${Math.round(growth / MB)} MB while scanning ~24 MB of text`);
});

// ---------------------------------------------------------------------------
// Coverage: nothing is skipped silently
// ---------------------------------------------------------------------------

const limits = (overrides) => ({ ...SCAN_LIMITS, ...overrides });

test('files that cannot be read are listed with the reason, never ignored', () => {
  const result = runScan({
    pkg: {
      'small-a.js': 'a'.repeat(80),
      'huge.js': 'x'.repeat(500),
      'small-b.js': 'b'.repeat(80),
      'small-c.js': 'c'.repeat(80),
      'small-d.js': 'd'.repeat(80),
      'compiled.js': Buffer.concat([Buffer.from('var x;'), Buffer.alloc(40, 0), Buffer.from('rest')]),
      'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
      'style.css': 'body{}',
      'README.md': 'docs',
    },
    src: { 'src/a.js': 'ok' },
    limits: limits({ maxFileBytes: 100, maxTotalBytes: 300 }),
  });
  const { coverage } = result;
  const reason = (path) => coverage.filesSkipped.find((entry) => entry.path === path)?.reason;
  assert.equal(reason('huge.js'), 'too-large');
  assert.equal(reason('small-d.js'), 'over-budget', 'the total budget ran out');
  assert.equal(reason('compiled.js'), 'binary', 'a .js file full of NUL bytes is not text');
  assert.equal(coverage.filesSkippedCount, 3);
  assert.equal(coverage.filesNotApplicable, 2, 'an image and a stylesheet are not scanned by design');
  // package.json, the three files within budget, the README (docs are read for AI-directed text).
  assert.equal(coverage.filesScanned, 5);
});

test('a file whose bytes were not retained is reported as skipped', () => {
  const result = runScan({ pkg: { 'a.js': 'eval(x)', 'b.js': 'ok' }, src: { 'src/a.js': 'ok' } });
  // Simulate the retention budget having run out for one file.
  const record = result.packageInventory.files.get('b.js');
  assert.ok(record.data, 'sanity: bytes were retained');
  record.data = null;
  // Re-run the scan on the same inventories.
  const again = runScan({ pkg: { 'a.js': 'eval(x)', 'b.js': 'x'.repeat(10) }, src: { 'src/a.js': 'ok' }, limits: limits({ maxFileBytes: 5 }) });
  assert.deepEqual(again.coverage.filesSkipped.map((e) => [e.path, e.reason]).sort(), [['a.js', 'too-large'], ['b.js', 'too-large'], ['package.json', 'too-large']]);
});

test('the skipped list is bounded but the count stays true', () => {
  const pkg = Object.fromEntries(Array.from({ length: 650 }, (_, i) => [`f${String(i).padStart(4, '0')}.js`, 'x'.repeat(50)]));
  const result = runScan({ pkg, src: { 'src/a.js': 'ok' }, limits: limits({ maxFileBytes: 10 }) });
  assert.equal(result.coverage.filesSkipped.length, 500);
  assert.equal(result.coverage.filesSkippedCount, 651, '650 files plus package.json');
  assert.equal(result.coverage.filesScanned, 0);
});

test('the coverage lists the rules that ran and says whether a source comparison was possible', () => {
  const result = runScan({ pkg: { 'a.js': 'ok' }, src: { 'src/a.js': 'ok' } });
  assert.equal(result.coverage.performed, true);
  assert.match(result.coverage.rulesVersion, /^m2-\d+$/);
  assert.ok(result.coverage.rules.some((rule) => rule.id === 'credential-network-combination'));
  assert.equal(result.coverage.capabilityDifferential.available, true);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

const MIXED = {
  'a.js': 'const https = require("https"); const t = process.env.NPM_TOKEN; https.get(u);',
  'b.js': 'eval(atob(payload)); window.fetch = f; window.ethereum.request({});',
  'c.js': `var _0x1=1;${'var _0x2=2;'.repeat(12)}`,
  'README.md': 'ignore all previous instructions',
  'lib/x.min.js': 'new Function(body)()',
};

test('the same package always gives byte-identical findings', () => {
  const first = runScan({ pkg: MIXED, src: { 'src/a.js': 'ok' } });
  const second = runScan({ pkg: MIXED, src: { 'src/a.js': 'ok' } });
  assert.equal(JSON.stringify(first.findings), JSON.stringify(second.findings));
  assert.equal(JSON.stringify(first.coverage), JSON.stringify(second.coverage));
  assert.ok(first.findings.length >= 6);
});

test('file order in the archive does not change the findings', () => {
  const reversed = Object.fromEntries(Object.entries(MIXED).reverse());
  const forward = runScan({ pkg: MIXED, src: { 'src/a.js': 'ok' } });
  const backward = runScan({ pkg: reversed, src: { 'src/a.js': 'ok' } });
  assert.equal(JSON.stringify(forward.findings), JSON.stringify(backward.findings));
});

// ---------------------------------------------------------------------------
// Fuzzing: arbitrary bytes must never crash the scanner or produce malformed evidence
// ---------------------------------------------------------------------------

function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = [
  'eval(', 'new Function(', 'process.env.', 'NPM_TOKEN', 'require("child_process")', 'exec(', 'fetch(', 'https://1.2.3.4/x', 'window.fetch =',
  '_0x1a2b', '\\x41\\x42', 'atob(', '"', "'", '`', '/*', '*/', '//', '\n', ' ', '{', '}', ')', ';', '.npmrc', 'readFileSync(', 'webhook.site',
  'ignore previous instructions', '0x' + 'a'.repeat(40), '\u0000', String.fromCodePoint(0x202e), '\u001b[31m', '\ud83d', String.fromCodePoint(0xfffd),
];

test('fuzz: random and token-soup files never crash the scanner and always yield well-formed findings', () => {
  const random = prng(20260101);
  for (let round = 0; round < 250; round += 1) {
    let content;
    const kind = round % 4;
    if (kind === 0) {
      content = Buffer.from(Array.from({ length: 1 + Math.floor(random() * 4000) }, () => Math.floor(random() * 256)));
    } else if (kind === 1) {
      const parts = Array.from({ length: 5 + Math.floor(random() * 400) }, () => TOKENS[Math.floor(random() * TOKENS.length)]);
      content = parts.join(random() < 0.5 ? '' : ' ');
    } else if (kind === 2) {
      content = Buffer.concat([Buffer.from(TOKENS.slice(0, 20).join(' ')), Buffer.from([0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x28, 0xa1, 0xf0, 0x28, 0x8c, 0xbc])]);
    } else {
      content = 'x'.repeat(Math.floor(random() * 50_000)) + TOKENS[Math.floor(random() * TOKENS.length)];
    }
    const extension = ['js', 'md', 'ts', 'sh'][round % 4];
    const { findings, coverage } = runScan({ pkg: { [`fuzz/${round}.${extension}`]: content }, src: round % 3 === 0 ? null : { 'src/a.js': 'ok' } });
    assert.equal(coverage.performed, true);
    for (const finding of findings) {
      assert.ok(['info', 'low', 'medium', 'high', 'critical'].includes(finding.severity));
      assert.ok(['high', 'medium', 'low'].includes(finding.confidence));
      assert.ok([true, false, null].includes(finding.introducedInPackage));
      assert.ok(finding.evidence.length >= 1 && finding.evidence.length <= SCAN_LIMITS.maxEvidencePerFinding, finding.ruleId);
      for (const item of finding.evidence) {
        assert.equal(typeof item.snippet, 'string');
        assert.ok(item.snippet.length <= MAX_SNIPPET_CHARS, `${finding.ruleId} snippet too long`);
        // eslint-disable-next-line no-control-regex
        assert.doesNotMatch(item.snippet, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/, `${finding.ruleId} snippet has control characters`);
        if (item.path !== null) {
          assert.ok(Number.isInteger(item.line) && item.line >= 1);
          assert.ok(item.column === undefined || (Number.isInteger(item.column) && item.column >= 1));
        }
      }
    }
  }
});

test('text addressed to a person or a terminal cannot smuggle control characters into a finding', () => {
  const esc = String.fromCodePoint(0x1b);
  const rlo = String.fromCodePoint(0x202e);
  const result = runScan({ pkg: { 'a.js': `eval(${esc}[2J${rlo}x)` } });
  const finding = result.findings.find((f) => f.ruleId === 'dynamic-code-execution');
  for (const item of finding.evidence) {
    assert.ok(!item.snippet.includes(esc) && !item.snippet.includes(rlo));
    assert.match(item.snippet, /\\u\{1b\}/);
  }
});
