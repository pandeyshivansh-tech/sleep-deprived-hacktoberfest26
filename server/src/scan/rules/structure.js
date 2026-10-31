import { evidenceFor, fileFinding, introducedFor, packageFinding } from '../finding.js';
import { isRiskyCommand } from '../indicators.js';
import { evidenceOf, hasSecretSource, hasSink } from './code-patterns.js';
import { clip, locate } from '../text.js';

const EVIDENCE_NOTE = ' This is a pattern match, not proof that the code runs or succeeds.';
const count = (file, id) => file.hits[id]?.length ?? 0;

// ---- obfuscation ----------------------------------------------------------
//
// Minified code is NOT obfuscation: popular packages ship minified bundles. The
// signals below are the fingerprints of obfuscator output (hex-named
// identifiers, a rotated string array) and of hidden data (long base64 literals,
// long hex-escape runs, character-code chains).

export const obfuscatedCode = {
  id: 'obfuscated-code',
  version: 1,
  kind: 'file',
  appliesTo: (file) => file.category === 'code',
  run(file, ctx) {
    const strong = [count(file, 'obf.hex-ident') >= 10 && 'obf.hex-ident', count(file, 'obf.string-array-rotate') >= 1 && 'obf.string-array-rotate'].filter(Boolean);
    const weak = [count(file, 'obf.hex-escapes') >= 3 && 'obf.hex-escapes', count(file, 'obf.long-base64') >= 1 && 'obf.long-base64', count(file, 'obf.fromcharcode') >= 1 && 'obf.fromcharcode'].filter(Boolean);
    if (strong.length === 0 && weak.length === 0) return [];

    // One weak feature alone (a data table, an embedded blob) is common in
    // legitimate packages, so it is listed without severity.
    let severity = 'info';
    let confidence = 'low';
    if (strong.length > 0) {
      severity = weak.length > 0 ? 'high' : 'medium';
      confidence = 'high';
    } else if (weak.length >= 2) {
      severity = 'medium';
      confidence = 'low';
    }
    return [
      fileFinding(ctx, file, {
        ruleId: 'obfuscated-code',
        severity,
        confidence,
        title: strong.length > 0 ? 'Looks machine-obfuscated' : 'Contains encoded or hard-to-read data',
        description: `The file shows ${strong.length > 0 ? 'the fingerprints of an obfuscator (hex-named identifiers or a rotated string array)' : 'long encoded strings'}${weak.length > 0 && strong.length > 0 ? ' together with encoded data' : ''}. Some legitimate packages obfuscate on purpose.${EVIDENCE_NOTE}`,
        evidence: evidenceOf(file, [...strong, ...weak], 2),
      }),
    ];
  },
};

// ---- global network hooks ---------------------------------------------------

export const networkHookWalletSwap = {
  id: 'network-hook-wallet-swap',
  version: 1,
  kind: 'file',
  appliesTo: (file) => file.category === 'code',
  run(file, ctx) {
    if (!file.hits['hook.fetch-xhr']) return [];
    if (!file.hits['hook.ethereum'] && count(file, 'wallet.address') < 2) return [];
    return [
      fileFinding(ctx, file, {
        ruleId: 'network-hook-wallet-swap',
        severity: 'high',
        // Hooking the network AND touching window.ethereum AND carrying addresses is a
        // specific signature; either wallet signal alone is weaker.
        confidence: file.hits['hook.ethereum'] && count(file, 'wallet.address') >= 1 ? 'high' : 'medium',
        title: 'Replaces browser network functions near cryptocurrency wallet code',
        description: `The file overwrites fetch or XMLHttpRequest and also refers to wallet addresses or window.ethereum, the pattern used to swap payment addresses in transit.${EVIDENCE_NOTE}`,
        evidence: evidenceOf(file, ['hook.fetch-xhr', 'hook.ethereum', 'wallet.address'], 2),
        capability: 'global-hook',
      }),
    ];
  },
};

export const globalNetworkHook = {
  id: 'global-network-hook',
  version: 1,
  kind: 'file',
  appliesTo: (file) => file.category === 'code',
  run(file, ctx) {
    if (!file.hits['hook.fetch-xhr']) return [];
    // The stronger wallet-swap finding already covers this file.
    if (file.hits['hook.ethereum'] || count(file, 'wallet.address') >= 2) return [];
    return [
      fileFinding(ctx, file, {
        ruleId: 'global-network-hook',
        severity: 'medium',
        confidence: 'low',
        title: 'Replaces a built-in network function',
        description: `The file assigns to fetch or XMLHttpRequest, which changes how every request in the page behaves. Polyfills and test tools do this legitimately.${EVIDENCE_NOTE}`,
        evidence: evidenceOf(file, ['hook.fetch-xhr'], 3),
        capability: 'global-hook',
      }),
    ];
  },
};

// ---- text addressed to an AI model -------------------------------------------

export const llmDirectedText = {
  id: 'llm-directed-text',
  version: 1,
  kind: 'file',
  appliesTo: (file) => ['code', 'doc', 'manifest'].includes(file.category),
  run(file, ctx) {
    if (!file.hits['llm.directive']) return [];
    return [
      fileFinding(ctx, file, {
        ruleId: 'llm-directed-text',
        severity: 'low',
        confidence: 'medium',
        title: 'Contains text that addresses an AI model',
        description: 'The file contains phrases such as "ignore previous instructions" that have no purpose for a human reader but can steer an AI tool that reads package contents. Audyssey treats package text as data and never as instructions.',
        evidence: evidenceFor(file, 'llm.directive', file.hits['llm.directive'], 3),
        introduced: introducedFor(ctx, file, null),
      }),
    ];
  },
};

// ---- native binaries ---------------------------------------------------------

export const unexpectedNativeBinary = {
  id: 'unexpected-native-binary',
  version: 1,
  kind: 'file',
  appliesTo: (file) => file.category === 'native',
  run(file, ctx) {
    const { format } = file;
    // WebAssembly is sandboxed and ordinary; native executables are not.
    const platformPackage = Array.isArray(ctx.publishedManifest?.os) || Array.isArray(ctx.publishedManifest?.cpu);
    const expected = format === 'wasm' || platformPackage;
    return [
      fileFinding(ctx, file, {
        ruleId: 'unexpected-native-binary',
        severity: expected ? 'info' : 'medium',
        confidence: 'low',
        title: format === 'wasm' ? 'Contains a WebAssembly module' : 'Contains a compiled executable',
        description: platformPackage
          ? 'The package declares the operating systems or CPUs it supports, which is how platform-specific packages ship compiled binaries.'
          : 'The package ships a compiled program. It cannot be compared with source text, so its contents are not inspected.',
        evidence: [{ path: file.path, line: 1, column: 1, indicator: `binary.${format}`, snippet: `${format} binary, ${file.record.size} bytes, sha256 ${file.record.sha256}` }],
      }),
    ];
  },
};

// ---- links that leave the package ---------------------------------------------

export const symlinkEscapesRoot = {
  id: 'symlink-escapes-root',
  version: 1,
  kind: 'link',
  run(link, ctx) {
    if (!link.record.linkEscapes) return [];
    return [
      fileFinding(ctx, link, {
        ruleId: 'symlink-escapes-root',
        severity: 'medium',
        confidence: 'high',
        title: `A ${link.record.type} points outside the package`,
        description: 'The link target resolves outside the package root, so it can expose files that are not part of the package once it is unpacked. Audyssey records links and never follows them.',
        evidence: [{ path: link.path, line: 1, column: 1, indicator: `link.${link.record.type}`, snippet: clip(`${link.record.type} to ${link.record.linkTarget}`) }],
        introduced: introducedFor(ctx, link, null),
      }),
    ];
  },
};

// ---- install scripts -----------------------------------------------------------
//
// M1 already extracts the install-time scripts of both package.json files. These
// rules judge them. A script in the package that the source does not have is the
// pattern behind several real incidents, so it is the strongest file-level signal.

// What makes a file risky enough to matter that an install script launches it: it
// downloads or decodes code, talks to a data-drop service, reads credentials and
// can send them out, or hooks the browser's network functions around wallet code.
function riskyBehavior(file) {
  const { hits } = file;
  if (hits['proc.import'] && hits['proc.risky-call']) return { indicator: 'proc.risky-call', what: 'starts a process whose command downloads or hides code' };
  if (hits['exec.decoded']) return { indicator: 'exec.decoded', what: 'decodes data and executes it' };
  if (hits['net.drop-host']) return { indicator: 'net.drop-host', what: 'refers to a service used to receive or stage data' };
  if (hasSecretSource(hits) && hasSink(hits)) return { indicator: hits['env.secret'] ? 'env.secret' : 'env.enumerate', what: 'reads credential-like values and can send data out' };
  if (hits['hook.fetch-xhr'] && (hits['hook.ethereum'] || count(file, 'wallet.address') >= 2)) return { indicator: 'hook.fetch-xhr', what: 'replaces browser network functions near wallet code' };
  return null;
}

const RUNS_FILE = /^(?:node|sh|bash|zsh|python3?|ruby|perl)\s+(?:--?[\w-]+(?:=\S+)?\s+)*([\w./@-]+)/;

function locateScript(file, name) {
  if (!file?.text) return { line: 1, column: 1 };
  const at = file.text.search(new RegExp(`"${name}"\\s*:`));
  return at === -1 ? { line: 1, column: 1 } : locate(file.lineStarts, at);
}

export const installScripts = {
  id: 'install-scripts',
  version: 1,
  kind: 'manifest',
  // This module reports under several rule ids; `ids` lists them for scan.rules.
  ids: ['install-script-added', 'install-script-changed', 'install-script-present', 'install-script-fetches-code', 'install-script-runs-unsourced-file', 'install-script-runs-risky-file'],
  run(manifestFile, ctx) {
    const { manifest } = ctx;
    const findings = [];
    for (const [name, command] of Object.entries(manifest.installScripts.package)) {
      const sourceCommand = manifest.installScripts.source[name];
      let ruleId;
      let severity;
      let confidence;
      let introduced;
      let title;
      if (!manifest.compared) {
        ruleId = 'install-script-present';
        severity = 'medium';
        confidence = 'medium';
        introduced = null;
        title = `Runs "${name}" when installed, and no source package.json could be compared`;
      } else if (sourceCommand === undefined) {
        ruleId = 'install-script-added';
        severity = 'high';
        confidence = 'high';
        introduced = true;
        title = `Adds a "${name}" script that the source does not have`;
      } else if (sourceCommand !== command) {
        ruleId = 'install-script-changed';
        severity = 'high';
        confidence = 'high';
        introduced = true;
        title = `Changes the "${name}" script compared with the source`;
      } else {
        ruleId = 'install-script-present';
        severity = 'info';
        confidence = 'high';
        introduced = false;
        title = `Runs "${name}" when installed (same as the source)`;
      }

      const { line, column } = locateScript(manifestFile, name);
      const evidence = [{ path: 'package.json', line, column, indicator: `script.${name}`, snippet: clip(`"${name}": ${JSON.stringify(command)}`) }];
      const base = { path: 'package.json', scope: 'file', introducedInPackage: introduced, evidence };
      findings.push({
        ...base,
        ruleId,
        severity,
        confidence,
        title,
        description: `npm runs install-time scripts automatically, with the installing user's privileges, before anyone reviews the code.${ruleId === 'install-script-present' && introduced === false ? ' The script is identical to the one in the source.' : ''}`,
      });

      if (isRiskyCommand(command)) {
        findings.push({
          ...base,
          ruleId: 'install-script-fetches-code',
          severity: 'high',
          confidence: 'high',
          title: `The "${name}" script downloads, pipes to a shell or decodes a command`,
          description: 'The command downloads something, pipes it to a shell, or hides itself in an encoded command. Scripts that only run bundled code do not need to.',
        });
      }

      const runs = RUNS_FILE.exec(command);
      if (runs) {
        const target = runs[1].replace(/^\.\//, '');
        const entry = ctx.entries.get(target);
        const runsFile = ctx.files.get(target);
        const risky = runsFile ? riskyBehavior(runsFile) : null;
        if (risky) {
          // Same rule as everywhere: a file identical to the reviewed source was reviewable.
          const sourceShowsIt = ctx.sourceResolved && entry?.status === 'identical';
          findings.push({
            ...base,
            ruleId: 'install-script-runs-risky-file',
            severity: sourceShowsIt ? 'info' : 'high',
            confidence: 'high',
            introducedInPackage: sourceShowsIt ? false : ctx.sourceResolved ? true : null,
            title: `The "${name}" script runs a file that ${risky.what}`,
            description: `The install-time script runs ${target}, and that file ${risky.what}. Install scripts run before anyone reviews the code. This is a pattern match, not proof of what the file does.`,
            evidence: [
              ...evidence,
              ...evidenceFor(runsFile, risky.indicator, runsFile.hits[risky.indicator] ?? [], 2),
            ],
          });
        }
        // Without a source snapshot every file looks "package-only"; that is a limit of
        // the comparison, not a fact about the package, so nothing is claimed.
        if (ctx.sourceResolved && entry && entry.status !== 'identical') {
          findings.push({
            ...base,
            ruleId: 'install-script-runs-unsourced-file',
            severity: 'medium',
            confidence: 'medium',
            introducedInPackage: ctx.sourceResolved ? true : null,
            title: `The "${name}" script runs a file that the source does not have`,
            description: `The script runs ${target}, which ${entry.status === 'package-only' ? 'exists only in the published package' : 'differs from the source'}.`,
            evidence: [...evidence, { path: target, line: 1, column: 1, indicator: 'script.target', snippet: clip(`${target} (${entry.status})`) }],
          });
        }
      }
    }
    return findings;
  },
};

// ---- integrity (package scope) ---------------------------------------------------

export const integrityRules = {
  id: 'integrity',
  version: 1,
  kind: 'package',
  ids: ['integrity-mismatch', 'package-identity-mismatch'],
  run(ctx) {
    const findings = [];
    const { integrity, identity } = ctx;
    if (integrity.expected && !integrity.verified) {
      const supplied = ctx.input.source === 'tarball';
      findings.push(
        packageFinding({
          ruleId: 'integrity-mismatch',
          severity: 'high',
          confidence: supplied ? 'high' : 'medium',
          title: supplied ? 'The supplied tarball is not the published release' : 'The downloaded tarball does not match the registry checksum',
          description: `The bytes that were analyzed do not match the checksum the npm registry publishes for this exact version. ${supplied ? 'The supplied file is not the published release.' : 'The download was corrupted or the registry served inconsistent data.'} This concerns the bytes, not the code: it is not proof of tampering by itself.`,
          snippet: clip(`expected ${integrity.expected}, got ${integrity.actual}`),
        }),
      );
    }
    if (identity && identity.actual && (identity.actual.name !== identity.expected.name || identity.actual.version !== identity.expected.version)) {
      findings.push(
        packageFinding({
          ruleId: 'package-identity-mismatch',
          severity: 'high',
          confidence: 'high',
          title: 'The tarball is for a different package or version',
          description: 'The package.json inside the tarball names a different package or version than the one that was requested.',
          snippet: clip(`requested ${identity.expected.name}@${identity.expected.version}, tarball says ${identity.actual.name}@${identity.actual.version}`),
        }),
      );
    }
    return findings;
  },
};
