#!/usr/bin/env node
// `npm run dev`: starts the API server and the dashboard together. It only runs the
// two existing workspace scripts (fixed arguments, no shell) and stops both on Ctrl-C.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const jobs = [
  { name: 'server', args: ['run', 'dev', '--workspace', 'server'] },
  { name: 'web', args: ['run', 'dev', '--workspace', 'web'] },
];

const children = jobs.map(({ name, args }) => {
  const child = spawn(npm, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (stream, out) => stream.on('data', (chunk) => out.write(String(chunk).replace(/^(?=.)/gm, `[${name}] `)));
  prefix(child.stdout, process.stdout);
  prefix(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`[${name}] exited with code ${code}; stopping.`);
      stop(code ?? 1);
    }
  });
  return child;
});

let stopping = false;
function stop(code = 0) {
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

console.log('Starting Audyssey. Defaults: API http://127.0.0.1:8787, dashboard http://127.0.0.1:5173 (Vite prints the exact URL below; Ctrl-C stops both)');
