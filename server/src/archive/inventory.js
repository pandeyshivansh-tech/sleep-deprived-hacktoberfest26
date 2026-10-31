import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { ArchiveError } from '../errors.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function linkEscapesRoot(entry, relativePath, root) {
  const target = entry.linkTarget;
  if (target.startsWith('/')) return true;
  if (entry.type === 'symlink') {
    const resolved = posix.normalize(posix.join(posix.dirname(relativePath), target));
    return resolved === '..' || resolved.startsWith('../');
  }
  // Hard link targets are archive paths, so they must stay under the same root.
  const resolved = posix.normalize(target);
  return !resolved.startsWith(`${root}/`);
}

// Turns parsed tar entries into a path-keyed inventory.
//
// - Every entry must live under one top-level directory (npm uses "package/",
//   GitHub uses "<repo>-<ref>/"). That directory is stripped.
// - `directory` restricts a source snapshot to a monorepo package subdirectory.
// - Files get a SHA-256 of their bytes; links get one of their target text, so a
//   changed or added link always shows up as a difference.
// - File bytes are kept only for files `retain(path, head)` accepts, and only
//   within the per-file and total retention budgets, so later stages can read
//   them; everything else is hashed and released. The first bytes of every file
//   are always kept (`head`) so executables can be recognised by magic number.
export function buildInventory(parsed, { directory = null, limits, retain = () => true }) {
  if (parsed.entries.length === 0) throw new ArchiveError('Archive is empty', 'empty-archive');

  const files = new Map();
  const stats = { directories: 0, files: 0, symlinks: 0, hardlinks: 0, outsideDirectory: 0 };
  let root = null;
  let retainedBytes = 0;

  for (const entry of parsed.entries) {
    const segments = entry.path === '' ? [] : entry.path.split('/');
    if (segments.length === 0) {
      stats.directories += 1; // the archive's own "./"
      continue;
    }
    if (entry.type !== 'directory' && segments.length < 2) {
      throw new ArchiveError(`Archive entry is not inside a top-level directory: ${JSON.stringify(entry.path)}`, 'entry-outside-root');
    }
    if (root === null) root = segments[0];
    if (segments[0] !== root) {
      throw new ArchiveError(
        `Archive entry is outside the archive's top-level directory "${root}": ${JSON.stringify(entry.path.slice(0, 120))}`,
        'entry-outside-root',
      );
    }

    let relativePath = segments.slice(1).join('/');
    if (relativePath === '') {
      stats.directories += 1; // the top-level directory itself
      continue;
    }
    if (directory !== null) {
      if (relativePath === directory && entry.type === 'directory') continue;
      if (!relativePath.startsWith(`${directory}/`)) {
        stats.outsideDirectory += 1;
        continue;
      }
      relativePath = relativePath.slice(directory.length + 1);
    }
    if (entry.type === 'directory') {
      stats.directories += 1;
      continue;
    }

    if (entry.type === 'file') {
      stats.files += 1;
      let data = null;
      const head = Buffer.from(entry.data.subarray(0, 16));
      const keep =
        retain(relativePath, head) &&
        entry.size <= limits.maxRetainedFileBytes &&
        retainedBytes + entry.size <= limits.maxRetainedTotalBytes;
      if (keep) {
        data = Buffer.from(entry.data); // copy: lets the large decompressed buffer be released
        retainedBytes += entry.size;
      }
      files.set(relativePath, {
        path: relativePath,
        type: 'file',
        size: entry.size,
        mode: entry.mode,
        sha256: sha256(entry.data),
        head,
        data,
      });
    } else {
      stats[entry.type === 'symlink' ? 'symlinks' : 'hardlinks'] += 1;
      files.set(relativePath, {
        path: relativePath,
        type: entry.type,
        size: Buffer.byteLength(entry.linkTarget),
        mode: entry.mode,
        sha256: sha256(Buffer.from(entry.linkTarget, 'utf8')),
        linkTarget: entry.linkTarget,
        linkEscapes: linkEscapesRoot(entry, relativePath, root),
        head: null,
        data: null,
      });
    }
  }

  return { rootName: root, files, stats };
}
