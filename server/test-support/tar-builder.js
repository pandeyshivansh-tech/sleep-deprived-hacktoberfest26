import { gzipSync } from 'node:zlib';

// Builds tar archives byte by byte inside tests so hostile archives (traversal,
// links, bombs, corrupt headers) can be constructed without touching the disk
// or the network.

const octal = (value, width) => value.toString(8).padStart(width - 1, '0') + '\0';

export function tarHeader({
  name,
  size = 0,
  type = '0',
  linkname = '',
  mode = 0o644,
  prefix = '',
  magic = 'ustar\0',
  badChecksum = false,
}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(octal(mode, 8), 100, 8, 'latin1');
  header.write(octal(0, 8), 108, 8, 'latin1');
  header.write(octal(0, 8), 116, 8, 'latin1');
  header.write(octal(size, 12), 124, 12, 'latin1');
  header.write(octal(0, 12), 136, 12, 'latin1');
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'latin1');
  header.write(linkname, 157, 100, 'utf8');
  header.write(magic, 257, 6, 'latin1');
  header.write('00', 263, 2, 'latin1');
  header.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(badChecksum ? '000000\0 ' : `${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return header;
}

const padding = (length) => Buffer.alloc((512 - (length % 512)) % 512);

// One regular-file (or link, directory, ...) entry: header, data, padding.
export function tarEntry(spec, data = '') {
  const body = Buffer.from(data);
  const header = tarHeader({ ...spec, size: spec.size ?? body.length });
  return Buffer.concat([header, body, padding(body.length)]);
}

// A pax extended header ('x', applies to the next entry) or global header ('g').
export function paxEntry(records, { global = false } = {}) {
  const lines = Object.entries(records).map(([key, value]) => {
    const payload = ` ${key}=${value}\n`;
    let length = payload.length + 1;
    while (`${length}${payload}`.length !== length) length = `${length}${payload}`.length;
    return `${length}${payload}`;
  });
  return tarEntry({ name: 'PaxHeader', type: global ? 'g' : 'x' }, lines.join(''));
}

export function buildTar(entries, { trailer = true } = {}) {
  return Buffer.concat([...entries, trailer ? Buffer.alloc(1024) : Buffer.alloc(0)]);
}

export const gz = (buffer) => gzipSync(buffer);

// A registry-style tarball: every file lives under "<root>/".
export function makeNpmTarball(files, { root = 'package', extraEntries = [] } = {}) {
  const entries = Object.entries(files).map(([path, content]) => tarEntry({ name: `${root}/${path}` }, content));
  return gz(buildTar([...entries, ...extraEntries]));
}

// A GitHub-style source archive: pax global header carrying the commit, then
// "<root>/" with an optional subdirectory prefix applied to the given files.
export function makeSourceTarball(files, { root = 'repo-abc123', commit = null } = {}) {
  const entries = [];
  if (commit) entries.push(paxEntry({ comment: commit }, { global: true }));
  entries.push(tarEntry({ name: `${root}/`, type: '5', mode: 0o755 }));
  for (const [path, content] of Object.entries(files)) {
    entries.push(tarEntry({ name: `${root}/${path}` }, content));
  }
  return gz(buildTar(entries));
}
