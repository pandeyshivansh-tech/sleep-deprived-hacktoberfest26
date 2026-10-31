import { SCAN_LIMITS } from '../limits.js';
import { findComments, inComment } from './text.js';

// Every pattern the scanner looks for, in one table, so each file is searched
// once and every rule (and the capability differential) reads the same hits.
//
// Patterns are heuristics over text. They do not parse the language, so they can
// match code that never runs and miss code that is built dynamically.
//
// Regex discipline (the input is attacker-controlled): no nested quantifiers and
// no unbounded quantifier next to another that can match the same characters.
// Where a pattern needs a variable-length value it matches a fixed anchor plus a
// bounded capture, and JavaScript validates the capture afterwards.

const Q = '[\'"`]';
const importOf = (moduleSource) =>
  new RegExp(`(?:require\\s*\\(\\s*|from\\s+|import\\s*\\(\\s*|import\\s+)${Q}(?:node:)?${moduleSource}${Q}`, 'g');
const PROC_NAMES = 'exec|execSync|execFile|execFileSync|spawn|spawnSync|fork';

// A command line that fetches code, pipes it to a shell, or hides in an encoded command.
const FETCH_COMMAND = /\b(?:curl|wget)\b|Invoke-WebRequest|\biwr\b|certutil|bitsadmin/i;
const PIPE_TO_SHELL = /\|\s*(?:sh|bash|zsh|pwsh|powershell|cmd)\b/i;
const ENCODED_COMMAND = /(?:powershell|pwsh)[^'"`\n]{0,80}-(?:enc|encodedcommand)\b|base64\s+(?:-d|--decode)/i;
export const isRiskyCommand = (command) => FETCH_COMMAND.test(command) || PIPE_TO_SHELL.test(command) || ENCODED_COMMAND.test(command);

// Text that decodes data (base64, character codes) near a call that runs text as code.
const DECODER = /\batob\s*\(|['"`]base64['"`]|fromCharCode|\bunescape\s*\(|\bcreateDecipher(?:iv)?\s*\(/;

const SECRET_ENV_WORDS = ['TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'CREDENTIAL', 'API_KEY', 'APIKEY', 'PRIVATE_KEY', 'ACCESS_KEY', 'AUTH_KEY', 'SESSION_KEY', 'NPM_AUTH', 'GH_PAT', 'GITHUB_PAT'];

// Public (routable) IPv4 addresses only: loopback, private, link-local and
// documentation ranges are ordinary in code and carry no signal.
function isPublicIp(match) {
  const octets = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/.exec(match[0]);
  if (!octets) return false;
  const [a, b, c] = octets.slice(1, 4).map(Number);
  const all = octets.slice(1, 5).map(Number);
  if (all.some((part) => part > 255)) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false;
  return true;
}

// `Function('return this')()` is the long-standing idiom for the global object
// (lodash, core-js and others use it); it executes nothing attacker-chosen.
const GLOBAL_THIS_IDIOM = /^\s*\(\s*['"`]\s*return\s+(?:this|globalThis|self|window|global)\s*;?\s*['"`]\s*\)/;

export const INDICATORS = [
  // ---- dynamic code execution ----
  { id: 'exec.eval', regexes: [/(?<![\w$.])eval\s*\(/g, /(?<![\w$])(?:window|global|globalThis|self)\s*\.\s*eval\s*\(/g] },
  {
    id: 'exec.new-function',
    regexes: [/(?<![\w$.])new\s+Function\s*\(/g, /(?<![\w$.])Function\s*\(/g],
    guard: (match, text) => {
      // A bare "Function(" that is really the tail of "new Function(" is counted once, by the other pattern.
      if (!match[0].startsWith('new') && /new\s+$/.test(text.slice(Math.max(0, match.index - 12), match.index))) return false;
      return !GLOBAL_THIS_IDIOM.test(text.slice(match.index + match[0].length - 1, match.index + match[0].length + 60));
    },
  },
  { id: 'exec.vm', regexes: [importOf('vm'), /\.\s*(?:runInThisContext|runInNewContext|runInContext)\s*\(|new\s+vm\.Script\s*\(/g] },
  { id: 'exec.timer-string', regexes: [new RegExp(`(?<![\\w$.])set(?:Timeout|Interval)\\s*\\(\\s*${Q}`, 'g')] },

  // ---- process execution ----
  { id: 'proc.import', regexes: [importOf('child_process')] },
  {
    id: 'proc.call',
    regexes: [
      new RegExp(`(?<![\\w$.])(?:${PROC_NAMES})\\s*\\(`, 'g'),
      new RegExp(`(?<![\\w$])(?:child_process|childProcess|cp)\\s*\\.\\s*(?:${PROC_NAMES})\\s*\\(`, 'g'),
      new RegExp(`require\\s*\\(\\s*${Q}(?:node:)?child_process${Q}\\s*\\)\\s*\\.\\s*(?:${PROC_NAMES})\\s*\\(`, 'g'),
    ],
    guard: (match, text) => text.slice(Math.max(0, match.index - 9), match.index) !== 'function ',
  },

  // ---- network ----
  { id: 'net.module', regexes: [importOf('(?:https?|http2|net|tls|dgram|dns)')] },
  {
    id: 'net.web',
    regexes: [/(?<![\w$.])fetch\s*\(/g, /(?<![\w$])(?:window|globalThis|self|global)\s*\.\s*fetch\s*\(/g, /\bXMLHttpRequest\b/g, /new\s+WebSocket\s*\(/g, /\.\s*sendBeacon\s*\(/g, /new\s+EventSource\s*\(/g],
  },
  { id: 'net.raw-ip', regexes: [/https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?![\d.])(?::\d{1,5})?/g], guard: (match) => isPublicIp(match) },
  {
    // Services commonly used to receive or stage stolen data. A short, fixed list
    // with a stated reason, not an allowlist of "known good" code.
    id: 'net.drop-host',
    regexes: [/(?:webhook\.site|requestbin\.(?:com|net)|pipedream\.net|ngrok(?:-free)?\.(?:io|app|dev)|oastify\.com|interact\.sh|burpcollaborator\.net|discord(?:app)?\.com\/api\/webhooks\/|api\.telegram\.org\/bot|pastebin\.com\/raw|transfer\.sh|0x0\.st|ix\.io\/|file\.io\/)/gi],
  },

  // ---- secrets and sensitive files ----
  {
    id: 'env.secret',
    regexes: [new RegExp(`process\\.env\\s*(?:\\.\\s*|\\[\\s*${Q})([A-Za-z0-9_]{1,128})`, 'g')],
    guard: (match) => {
      const name = match[1].toUpperCase();
      return SECRET_ENV_WORDS.some((word) => name.includes(word));
    },
  },
  {
    id: 'env.enumerate',
    regexes: [/Object\s*\.\s*(?:keys|values|entries)\s*\(\s*process\.env\s*\)/g, /JSON\s*\.\s*stringify\s*\(\s*process\.env\b/g],
  },
  {
    id: 'file.sensitive',
    regexes: [/(?:\.npmrc|\.ssh[\\/]|id_rsa|id_ed25519|\.aws[\\/]credentials|\.git-credentials|\.netrc\b|\.docker[\\/]config\.json|\.kube[\\/]config|Login Data|Local State|\.config[\\/](?:gcloud|gh)\b|\/etc\/(?:passwd|shadow)|\.(?:bash|zsh)_history|wallet\.dat|\.electrum|Exodus|MetaMask|Library\/Keychains|login\.keychain)/g],
  },
  // Context only (a sensitive path matters more next to a file read), never a finding on its own.
  { id: 'file.read', regexes: [/(?<![\w$])(?:readFile|readFileSync|createReadStream|readdirSync|readdir|openSync|copyFileSync|copyFile)\s*\(/g, importOf('fs(?:\\/promises)?')] },

  // ---- obfuscation ----
  { id: 'obf.hex-ident', regexes: [/\b_0x[0-9a-f]{3,8}\b/gi] },
  {
    id: 'obf.string-array-rotate',
    regexes: [/\[\s*['"]push['"]\s*\]\s*\(\s*[^()]{0,100}\[\s*['"]shift['"]\s*\]\s*\(/g, /while\s*\(\s*!!\s*\[\s*\]\s*\)\s*\{\s*try\s*\{/g],
  },
  { id: 'obf.hex-escapes', regexes: [/(?:\\x[0-9a-fA-F]{2}){16,}/g] },
  {
    id: 'obf.long-base64',
    regexes: [new RegExp(`${Q}[A-Za-z0-9+/]{400,}={0,2}${Q}`, 'g')],
    // Embedded assets (fonts, images) are legitimately long base64 data URIs.
    guard: (match, text) => !/(?:base64,|data:)/.test(text.slice(Math.max(0, match.index - 40), match.index)),
  },
  { id: 'obf.fromcharcode', regexes: [/String\s*\.\s*fromCharCode\s*\(\s*(?:\d{1,3}\s*,\s*){20,}\d{1,3}/g] },

  // ---- global network hooks (the wallet-address-swap pattern) ----
  {
    id: 'hook.fetch-xhr',
    regexes: [/(?<![\w$])(?:window|self|globalThis|global)\s*\.\s*fetch\s*=(?!=)/g, /XMLHttpRequest\s*\.\s*prototype\s*\.\s*(?:open|send|setRequestHeader)\s*=(?!=)/g, /(?<![\w$])(?:window|self|globalThis)\s*\.\s*XMLHttpRequest\s*=(?!=)/g],
  },
  { id: 'hook.ethereum', regexes: [/\bwindow\s*\.\s*ethereum\b/g, /\bethereum\s*\.\s*(?:request|send|sendAsync|enable)\s*\(/g] },
  { id: 'wallet.address', regexes: [/\b0x[a-fA-F0-9]{40}\b/g] },

  // ---- text addressed to an AI model ----
  {
    id: 'llm.directive',
    categories: ['code', 'doc', 'manifest'],
    regexes: [/(?:ignore|disregard)\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above)\s+(?:instructions|prompts?)|(?:reveal|print|output)\s+(?:your\s+)?system\s+prompt|<\|im_(?:start|end)\|>|\[\/?INST\]/gi],
  },
];

const BY_ID = new Map(INDICATORS.map((indicator) => [indicator.id, indicator]));
export const indicatorById = (id) => BY_ID.get(id);

const HASH_COMMENT_EXTENSIONS = new Set(['sh', 'bash', 'zsh', 'py', 'rb', 'pl', 'ps1']);
const EXEC_IDS = ['exec.eval', 'exec.new-function', 'exec.vm'];

// Are all arguments plain string literals, up to the closing parenthesis? Only the
// next 300 characters are looked at, so the check is bounded. For Function(...)
// the last argument is the body, so every argument must be a literal.
const LITERAL_ARGS = /^\s*(?:(?:'[^'\\\n]*'|"[^"\\\n]*"|`[^`\\$]*`)\s*,?\s*)+\)/;
const hasOnlyLiteralArguments = (text, from) => LITERAL_ARGS.test(text.slice(from, from + 300));

// Escalated variants of a base indicator, found among its hits. They are
// separate indicators (and, below, separate capabilities) on purpose: a source
// that merely uses eval("1+1") must not excuse a published eval(atob(...)).
//   exec.computed   eval / Function called with something other than a string literal
//   exec.decoded    a call that runs text as code, close to a decoder
//   proc.risky-call a process call whose command fetches code, pipes to a shell or is encoded
function deriveEscalations(text, hits) {
  const hit = (list) => (list.length > 0 ? list : undefined);
  const executing = EXEC_IDS.flatMap((id) => hits[id] ?? []);
  hits['exec.decoded'] = hit(executing.filter((entry) => DECODER.test(text.slice(Math.max(0, entry.index - 300), entry.index + entry.length + 250))));
  hits['exec.computed'] = hit(
    [...(hits['exec.eval'] ?? []), ...(hits['exec.new-function'] ?? [])].filter((entry) => !hasOnlyLiteralArguments(text, entry.index + entry.length)),
  );
  hits['proc.risky-call'] = hit((hits['proc.call'] ?? []).filter((call) => isRiskyCommand(text.slice(call.index + call.length, call.index + call.length + 240))));
  for (const key of ['exec.decoded', 'exec.computed', 'proc.risky-call']) if (!hits[key]) delete hits[key];
}

// Searches one file. Returns { hits, commentedOut }: hits maps an indicator id to
// up to `maxMatchesPerIndicator` { index, length } entries in file order.
export function findIndicators(text, { category, extension }) {
  const commentable = category === 'code' && extension !== 'html' && extension !== 'htm' && extension !== 'svg';
  const comments = commentable ? findComments(text, { hashComments: HASH_COMMENT_EXTENSIONS.has(extension) }) : [];
  const limit = SCAN_LIMITS.maxMatchesPerIndicator;
  const hits = {};
  let commentedOut = 0;

  for (const indicator of INDICATORS) {
    if (!(indicator.categories ?? ['code']).includes(category)) continue;
    const found = [];
    for (const regex of indicator.regexes) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        if (match[0].length === 0) {
          regex.lastIndex += 1;
          continue;
        }
        if (comments.length > 0 && inComment(comments, match.index)) {
          commentedOut += 1;
          continue;
        }
        if (indicator.guard && !indicator.guard(match, text)) continue;
        found.push({ index: match.index, length: match[0].length });
        if (found.length >= limit) break;
      }
      if (found.length >= limit) break;
    }
    if (found.length > 0) {
      // Several patterns can match the same spot; keep one hit per stretch of text.
      let end = -1;
      hits[indicator.id] = found
        .sort((a, b) => a.index - b.index)
        .filter((entry) => {
          if (entry.index < end) return false;
          end = entry.index + entry.length;
          return true;
        });
    }
  }
  if (category === 'code') deriveEscalations(text, hits);
  return { hits, commentedOut };
}

// The behaviors a file shows, as a set of capability names. Escalated forms are
// their own capabilities so the source has to show the dangerous form itself.
export function capabilitiesOf(hits) {
  const capabilities = new Set();
  const has = (...ids) => ids.some((id) => hits[id]);
  if (has('exec.eval', 'exec.new-function', 'exec.vm', 'exec.timer-string')) capabilities.add('dynamic-exec');
  if (has('exec.computed')) capabilities.add('dynamic-exec-computed');
  if (has('exec.decoded')) capabilities.add('decoded-exec');
  if (has('proc.import') && has('proc.call')) capabilities.add('process-exec');
  if (has('proc.import') && has('proc.risky-call')) capabilities.add('process-exec-risky');
  if (has('net.module', 'net.web')) capabilities.add('network');
  if (has('env.secret')) capabilities.add('secret-env');
  if (has('env.enumerate')) capabilities.add('env-enumerate');
  if (has('file.sensitive')) capabilities.add('sensitive-files');
  if (has('hook.fetch-xhr')) capabilities.add('global-hook');
  return capabilities;
}
