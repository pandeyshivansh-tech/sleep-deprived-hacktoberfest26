import { readFile as fsReadFile, stat, writeFile as fsWriteFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { analyzeNpmPackage } from './analyze.js';
import { parseSpec } from './ecosystems/npm/spec.js';
import { AudysseyError, InputError } from './errors.js';
import { resolveOllamaBaseUrl } from './config.js';
import { DEFAULT_LIMITS } from './limits.js';
import { formatSummary } from './report/summary.js';
import { escapeUnsafe } from './scan/text.js';
import { resolveInterval, watchPackage } from './watch.js';

export const USAGE = `Usage:
  audyssey analyze <name>@<version> [--ai] [--json] [--out <file>]
  audyssey analyze --tarball <file.tgz> [<name>@<version>] [--ai] [--json] [--out <file>]
  audyssey watch <name> [--interval <seconds>] [--since <version>] [--once] [--ai] [--json]

Compares a published npm package with its source repository.
Nothing from the package is executed, installed or written to disk.

Options:
  --ai               Also interpret the result with local models through Ollama
                     (gemma4:e4b, then deepseek-r1:8b). Advisory only: it never
                     changes a finding or the score. Needs Ollama running locally.
  --json             Print the full JSON report instead of the text summary
  --out <file>       Also write the JSON report to <file>
  --tarball <file>   Analyze a local .tgz instead of downloading it. The registry
                     metadata and source are still looked up for the package it names.
  watch              Poll the npm registry for a newer release of <name> and analyze each
                     new version once (same pipeline and report as analyze). Stops on
                     Ctrl-C. --interval is 60..86400 seconds (default 300); --since is the
                     version to compare against (default: the latest at start); --once
                     checks a single time and exits.
  -h, --help         Show this help

Exit codes: 0 report produced, 1 analysis failed, 2 invalid input.`;

// Runs the CLI. All I/O is injected so tests never touch the network or disk.
export async function run(
  argv,
  {
    stdout = process.stdout,
    stderr = process.stderr,
    fetchImpl = fetch,
    readFile = fsReadFile,
    statFile = stat,
    writeFile = fsWriteFile,
    limits = DEFAULT_LIMITS,
    now,
    env = process.env,
    aiFetchImpl = fetch,
    signal,
    watchSleep,
  } = {},
) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        out: { type: 'string' },
        ai: { type: 'boolean', default: false },
        tarball: { type: 'string' },
        interval: { type: 'string' },
        since: { type: 'string' },
        once: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }

  const [command, spec, ...extra] = args.positionals;
  if (args.values.help || command === undefined) {
    (args.values.help ? stdout : stderr).write(`${USAGE}\n`);
    return args.values.help ? 0 : 2;
  }
  if (command === 'watch' && spec !== undefined && extra.length === 0 && !args.values.tarball && !args.values.out) {
    return runWatch({ name: spec, args, stdout, stderr, fetchImpl, limits, now, env, aiFetchImpl, signal, sleep: watchSleep });
  }
  if (command !== 'analyze' || extra.length > 0 || (spec === undefined && !args.values.tarball)) {
    stderr.write(`${USAGE}\n`);
    return 2;
  }

  try {
    let name;
    let version;
    if (spec !== undefined) ({ name, version } = parseSpec(spec));

    let tarballBytes = null;
    if (args.values.tarball) {
      const size = (await statFile(args.values.tarball)).size;
      if (size > limits.package.maxCompressedBytes) {
        throw new InputError(`${args.values.tarball} is larger than the ${limits.package.maxCompressedBytes} byte limit`, 'too-large');
      }
      tarballBytes = await readFile(args.values.tarball);
    }

    let ollama = null;
    if (args.values.ai) {
      try {
        ollama = { baseUrl: resolveOllamaBaseUrl(env.OLLAMA_BASE_URL || undefined), fetchImpl: aiFetchImpl };
      } catch (error) {
        throw new InputError(error.message, 'bad-ollama-url');
      }
    }

    const { report } = await analyzeNpmPackage({
      ai: ollama,
      name,
      version,
      tarballBytes,
      fetchImpl,
      limits,
      now,
      onProgress: (message) => stderr.write(`- ${message}\n`),
    });

    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (args.values.out) await writeFile(args.values.out, json);
    stdout.write(args.values.json ? json : `${formatSummary(report)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof InputError) {
      stderr.write(`Error: ${escapeUnsafe(error.message)}\n`);
      return 2;
    }
    if (error instanceof AudysseyError) {
      stderr.write(`Error: ${escapeUnsafe(error.message)}\n`);
      return 1;
    }
    if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EISDIR') {
      stderr.write(`Error: cannot read ${args.values.tarball ?? 'the file'} (${error.code})\n`);
      return 2;
    }
    stderr.write(`Unexpected error: ${error?.stack ?? error}\n`);
    return 1;
  }
}

// `audyssey watch`: prints what the registry and the analysis actually returned.
async function runWatch({ name, args, stdout, stderr, fetchImpl, limits, now, env, aiFetchImpl, signal, sleep }) {
  const stamp = () => (now ? now() : new Date()).toISOString().slice(11, 19);
  const controller = new AbortController();
  const stop = () => controller.abort();
  const onAbort = signal ? () => controller.abort() : null;
  signal?.addEventListener('abort', onAbort, { once: true });
  if (!signal) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  try {
    const intervalSeconds = resolveInterval(args.values.interval);
    let ollama = null;
    if (args.values.ai) {
      try {
        ollama = { baseUrl: resolveOllamaBaseUrl(env.OLLAMA_BASE_URL || undefined), fetchImpl: aiFetchImpl };
      } catch (error) {
        throw new InputError(error.message, 'bad-ollama-url');
      }
    }
    stdout.write(`[${stamp()}] Watching ${escapeUnsafe(name)} on the npm registry${args.values.once ? ' (single check)' : ` every ${intervalSeconds} s; Ctrl-C to stop`}\n`);
    const result = await watchPackage({
      name,
      since: args.values.since ?? null,
      intervalSeconds,
      once: args.values.once,
      fetchImpl,
      limits,
      ai: ollama,
      signal: controller.signal,
      sleep,
      now,
      onProgress: (message) => stderr.write(`- ${message}\n`),
      onEvent: (event) => {
        if (event.type === 'baseline') stdout.write(`[${stamp()}] Latest is ${event.version}; watching for anything newer.\n`);
        else if (event.type === 'unchanged') stdout.write(`[${stamp()}] ${event.version} is still the latest.\n`);
        else if (event.type === 'release') stdout.write(`[${stamp()}] New release: ${escapeUnsafe(name)}@${event.version} (was ${event.previous}). Analyzing…\n`);
        else if (event.type === 'report') stdout.write(`${args.values.json ? `${JSON.stringify(event.report, null, 2)}\n` : `${formatSummary(event.report)}\n`}`);
        else stderr.write(`[${stamp()}] ${event.stage} failed: ${event.message}${args.values.once ? '' : ' (will retry)'}\n`);
      },
    });
    if (controller.signal.aborted) stdout.write(`[${stamp()}] Stopped after ${result.checks} check(s).\n`);
    return result.failed ? 1 : 0;
  } catch (error) {
    if (error instanceof InputError) {
      stderr.write(`Error: ${escapeUnsafe(error.message)}\n`);
      return 2;
    }
    stderr.write(`Error: ${error instanceof AudysseyError ? escapeUnsafe(error.message) : 'unexpected failure'}\n`);
    return 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
