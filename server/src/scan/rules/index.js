import {
  credentialNetworkCombination,
  decodedCodeExecution,
  dynamicCodeExecution,
  hardcodedEndpoint,
  networkAccess,
  processExecution,
  sensitiveEnvAccess,
  sensitiveFileAccess,
} from './code-patterns.js';
import {
  globalNetworkHook,
  installScripts,
  integrityRules,
  llmDirectedText,
  networkHookWalletSwap,
  obfuscatedCode,
  symlinkEscapesRoot,
  unexpectedNativeBinary,
} from './structure.js';

// Rule kinds:
//   file      runs on each scanned text file the rule applies to
//   link      runs on each symlink or hard link
//   manifest  runs once, on package.json
//   package   runs once, with no file
// A rule module may report under several rule ids (`ids`).
export const RULES = Object.freeze([
  dynamicCodeExecution,
  decodedCodeExecution,
  processExecution,
  networkAccess,
  hardcodedEndpoint,
  sensitiveEnvAccess,
  sensitiveFileAccess,
  credentialNetworkCombination,
  obfuscatedCode,
  networkHookWalletSwap,
  globalNetworkHook,
  llmDirectedText,
  unexpectedNativeBinary,
  symlinkEscapesRoot,
  installScripts,
  integrityRules,
]);

export const ruleIds = (rule) => rule.ids ?? [rule.id];
export const RULE_LIST = Object.freeze(RULES.flatMap((rule) => ruleIds(rule).map((id) => ({ id, version: rule.version }))));
