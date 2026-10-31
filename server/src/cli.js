import { readFile as fsReadFile, stat, writeFile as fsWriteFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { analyzeNpmPackage } from './analyze.js';
import { parseSpec } from './ecosystems/npm/spec.js';
import { AudysseyError, InputError } from './errors.js';
import { DEFAULT_LIMITS } from './limits.js';
import { formatSummary } from './report/summary.js';

export const USAGE = `Usage:
  audyssey analyze <name>@<version> [--json] [--out <file>]
  audyssey analyze --tarball <file.tgz> [<name>@<version>] [--json] [--out <file>]

Compares a published npm package with its source repository.
Nothing from the package is executed, installed or written to disk.

Options:
  --json             Print the full JSON report instead of the text summary
  --out <file>       Also write the JSON report to <file>
  --tarball <file>   Analyze a local .tgz instead of downloading it. The registry
                     metadata and source are still looked up for the package it names.
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
        tarball: { type: 'string' },
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

    const { report } = await analyzeNpmPackage({
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
      stderr.write(`Error: ${error.message}\n`);
      return 2;
    }
    if (error instanceof AudysseyError) {
      stderr.write(`Error: ${error.message}\n`);
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
