import { SCAN_LIMITS } from '../../limits.js';
import { byPosition, evidenceFor, fileFinding, introducedFor } from '../finding.js';

// Rules over code files: dynamic execution, process execution, network use,
// hard-coded endpoints, secrets and sensitive files. Each reads the indicator
// hits found once per file, and reports what the code *attempts*, never what it
// achieves.

const EVIDENCE_NOTE = ' This is a pattern match, not proof that the code runs or succeeds.';

// A few matches from each indicator (so a finding shows both sides of a
// combination), in file order, within the evidence limit.
export function evidenceOf(file, ids, perIndicator = 2, max = SCAN_LIMITS.maxEvidencePerFinding) {
  return ids
    .flatMap((id) => evidenceFor(file, id, file.hits[id] ?? [], perIndicator))
    .sort(byPosition)
    .slice(0, max);
}

const EXEC_IDS = ['exec.eval', 'exec.new-function', 'exec.vm', 'exec.timer-string'];
const overlaps = (hits, hit) => (hits ?? []).some((other) => other.index < hit.index + hit.length && hit.index < other.index + other.length);

export const dynamicCodeExecution = {
  id: 'dynamic-code-execution',
  version: 1,
  kind: 'file',
  appliesTo: (file) => file.category === 'code',
  run(file, ctx) {
    // A decode-then-run chain is its own, stronger finding; do not count it twice.
    const hits = EXEC_IDS.flatMap((id) => (file.hits[id] ?? []).map((hit) => ({ id, ...hit })))
      .filter((hit) => !overlaps(file.hits['exec.decoded'], hit))
      .sort((a, b) => a.index - b.index);
    if (hits.length === 0) return [];
    const computed = hits.some((hit) => overlaps(file.hits['exec.computed'], hit));
    return [
      fileFinding(ctx, file, {
        ruleId: 'dynamic-code-execution',
        severity: computed ? 'medium' : 'low',
        confidence: 'medium',
        title: 'Runs code built at runtime',
        description: `The file calls ${computed ? 'eval or Function with a value computed at runtime' : 'eval, Function, vm or a string timer'}, which executes text as code.${EVIDENCE_NOTE}`,
        evidence: hits
          .slice(0, SCAN_LIMITS.maxEvidencePerFinding)
          .map((hit) => evidenceFor(file, hit.id, [hit], 1)[0])
          .sort(byPosition),
        capability: computed ? 'dynamic-exec-computed' : 'dynamic-exec',
      }),
    ];
  },
};

export const decodedCodeExecution = {
  id: 'decoded-code-execution',
  version: 1,
  kind: 'file',
  appliesTo: (file) => file.category === 'code',
  run(file, ctx) {
    const chained = file.hits['exec.decoded'];
    if (!chained) return [];
    return [
      fileFinding(ctx, file, {
        ruleId: 'decoded-code-execution',
        severity: 'high',
        confidence: 'high',
        title: 'Decodes text and then executes it',
        description: `The file decodes data (for example base64 or character codes) close to a call that executes text as code, which is how a hidden payload is typically run.${EVIDENCE_NOTE}`,
        evidence: evidenceFor(file, 'exec.decoded', chained, SCAN_LIMITS.maxEvidencePerFinding),
        capability: 'decoded-exec',
      }),
    ];
  },
};

export const processExecution = {
  id: 'process-execution',
  version: 1,
  kind: 'file',
  appliesTo: (file) => file.category === 'code',
  run(file, ctx) {
    const calls = file.hits['proc.call'];
    if (!file.hits['proc.import'] || !calls) return [];
    const risky = file.hits['proc.risky-call'];
    return [
      fileFinding(ctx, file, {
        ruleId: 'process-execution',
        severity: risky ? 'medium' : 'low',
        confidence: 'medium',
        title: risky ? 'Starts a process with a command that downloads or hides code' : 'Starts other processes',
        description: `The file imports child_process and starts a process${risky ? ' whose command downloads code, pipes it to a shell or is encoded' : ''}.${EVIDENCE_NOTE}`,
        evidence: [...evidenceFor(file, 'proc.import', file.hits['proc.import'], 1), ...evidenceFor(file, risky ? 'proc.risky-call' : 'proc.call', risky ?? calls, 4)].sort(byPosition),
        capability: risky ? 'process-exec-risky' : 'process-exec',
      }),
    ];
  },
};

export const networkAccess = {
  id: 'network-access',
  version: 1,
  kind: 'file',
  appliesTo: (file) => file.category === 'code',
  run(file, ctx) {
    if (!file.hits['net.module'] && !file.hits['net.web']) return [];
    // Network use that the reviewed source also shows is expected; only new network
    // use is worth listing. It carries no severity: it matters in combination.
    if (introducedFor(ctx, file, 'network') === false) return [];
    return [
      fileFinding(ctx, file, {
        ruleId: 'network-access',
        severity: 'info',
        confidence: 'high',
        title: 'Can make network requests',
        description: `The file uses network APIs and the source snapshot has no network code${ctx.sourceResolved ? '' : ' (no source snapshot was available to compare)'}.${EVIDENCE_NOTE}`,
        evidence: evidenceOf(file, ['net.module', 'net.web']),
        capability: 'network',
      }),
    ];
  },
};

export const hardcodedEndpoint = {
  id: 'hardcoded-endpoint',
  version: 1,
  kind: 'file',
  appliesTo: (file) => file.category === 'code',
  run(file, ctx) {
    if (!file.hits['net.raw-ip'] && !file.hits['net.drop-host']) return [];
    const dropHost = Boolean(file.hits['net.drop-host']);
    return [
      fileFinding(ctx, file, {
        ruleId: 'hardcoded-endpoint',
        severity: dropHost ? 'medium' : 'low',
        confidence: 'medium',
        title: dropHost ? 'Refers to a service often used to receive or stage data' : 'Refers to a raw IP address',
        description: `The file contains ${dropHost ? 'the address of a webhook, paste or tunnel service' : 'a URL that uses a public IP address instead of a name'}. Legitimate software uses such addresses too.${EVIDENCE_NOTE}`,
        evidence: evidenceOf(file, ['net.drop-host', 'net.raw-ip']),
      }),
    ];
  },
};

export const sensitiveEnvAccess = {
  id: 'sensitive-env-access',
  version: 1,
  kind: 'file',
  appliesTo: (file) => file.category === 'code',
  run(file, ctx) {
    if (!file.hits['env.secret'] && !file.hits['env.enumerate']) return [];
    const enumerates = Boolean(file.hits['env.enumerate']);
    return [
      fileFinding(ctx, file, {
        ruleId: 'sensitive-env-access',
        severity: enumerates ? 'medium' : 'low',
        confidence: 'medium',
        title: enumerates ? 'Reads every environment variable' : 'Reads secret-looking environment variables',
        description: `The file ${enumerates ? 'lists all environment variables, which include credentials' : 'reads environment variables whose names suggest credentials (token, secret, password, key)'}.${EVIDENCE_NOTE}`,
        evidence: evidenceOf(file, ['env.enumerate', 'env.secret']),
        capability: enumerates ? 'env-enumerate' : 'secret-env',
      }),
    ];
  },
};

export const sensitiveFileAccess = {
  id: 'sensitive-file-access',
  version: 1,
  kind: 'file',
  appliesTo: (file) => file.category === 'code',
  run(file, ctx) {
    if (!file.hits['file.sensitive']) return [];
    const reads = Boolean(file.hits['file.read']);
    return [
      fileFinding(ctx, file, {
        ruleId: 'sensitive-file-access',
        severity: reads ? 'medium' : 'low',
        confidence: reads ? 'medium' : 'low',
        title: 'Refers to credential or wallet files',
        description: `The file names a credential, key or wallet location (for example .npmrc, .ssh, browser profiles)${reads ? ' and uses file-reading APIs' : ''}.${EVIDENCE_NOTE}`,
        evidence: evidenceOf(file, ['file.sensitive', 'file.read']),
        capability: 'sensitive-files',
      }),
    ];
  },
};

export const hasSecretSource = (hits) => hits['env.secret'] || hits['env.enumerate'] || (hits['file.sensitive'] && hits['file.read']);
export const hasSink = (hits) => hits['net.module'] || hits['net.web'] || hits['net.drop-host'] || hits['net.raw-ip'] || (hits['proc.import'] && hits['proc.call']);
const hasStrongObfuscation = (hits) => (hits['obf.hex-ident']?.length ?? 0) >= 10 || Boolean(hits['obf.string-array-rotate']);

export const credentialNetworkCombination = {
  id: 'credential-network-combination',
  version: 1,
  kind: 'file',
  appliesTo: (file) => file.category === 'code',
  run(file, ctx) {
    const { hits } = file;
    if (!hasSecretSource(hits) || !hasSink(hits)) return [];
    const introduced = introducedFor(ctx, file, null);
    // Critical is reserved for credentials plus a way out, hidden behind
    // obfuscation or a global hook, in a file that is new in the package.
    const hidden = hasStrongObfuscation(hits) || Boolean(hits['hook.fetch-xhr']);
    const critical = hidden && introduced === true;
    return [
      fileFinding(ctx, file, {
        ruleId: 'credential-network-combination',
        severity: critical ? 'critical' : 'high',
        confidence: 'medium',
        title: 'Reads credentials and can send data out',
        description: `The same file reads credential-like values or files and also makes network requests or starts processes${critical ? ', and it is obfuscated or hooks network APIs' : ''}. This is an attempt-level signal, not proof that anything was sent.${EVIDENCE_NOTE}`,
        evidence: evidenceOf(file, ['env.secret', 'env.enumerate', 'file.sensitive', 'net.module', 'net.web', 'net.drop-host', 'net.raw-ip', 'proc.call']),
        introduced,
      }),
    ];
  },
};
