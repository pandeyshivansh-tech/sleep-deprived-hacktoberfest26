import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { ArchiveError } from '../errors.js';

// A bounded, in-memory tar reader for untrusted archives. Nothing is written to
// disk and no link is ever followed. Anything malformed, hostile or over a limit
// throws an ArchiveError instead of being skipped: a quietly dropped entry is
// exactly where an attacker would hide something.

const BLOCK = 512;
const MAX_META_BYTES = 1024 * 1024; // pax / GNU long-name records
const gunzipAsync = promisify(gunzip);
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(bytes, what) {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    throw new ArchiveError(`${what} is not valid UTF-8`, 'unsafe-path');
  }
}

function cString(buffer) {
  const end = buffer.indexOf(0);
  return end === -1 ? buffer : buffer.subarray(0, end);
}

function parseOctal(field, what) {
  if (field[0] & 0x80) {
    throw new ArchiveError(`Unsupported binary number encoding in tar field "${what}"`, 'bad-header');
  }
  const text = cString(field).toString('latin1').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new ArchiveError(`Malformed number in tar field "${what}"`, 'bad-header');
  }
  return Number.parseInt(text, 8);
}

function checksumMatches(header) {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum === parseOctal(header.subarray(148, 156), 'checksum');
}

function isZeroBlock(header) {
  for (let index = 0; index < BLOCK; index += 1) {
    if (header[index] !== 0) return false;
  }
  return true;
}

// Returns the normalized, root-relative-to-archive path ('' for the archive root
// directory). Throws on anything that could escape or confuse a consumer.
export function normalizeArchivePath(raw, limits) {
  if (raw.includes('\0')) throw new ArchiveError('Archive entry path contains a NUL byte', 'unsafe-path');
  if (raw.length > limits.maxPathLength) {
    throw new ArchiveError(`Archive entry path is longer than ${limits.maxPathLength} characters`, 'limit');
  }
  if (raw.includes('\\')) {
    throw new ArchiveError(`Archive entry path contains a backslash: ${JSON.stringify(raw.slice(0, 120))}`, 'unsafe-path');
  }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new ArchiveError(`Archive entry has an absolute path: ${JSON.stringify(raw.slice(0, 120))}`, 'unsafe-path');
  }

  const segments = [];
  for (const segment of raw.split('/')) {
    if (segment === '..') {
      throw new ArchiveError(`Archive entry escapes its root with "..": ${JSON.stringify(raw.slice(0, 120))}`, 'unsafe-path');
    }
    if (segment !== '' && segment !== '.') segments.push(segment);
  }
  if (segments.length > limits.maxPathDepth) {
    throw new ArchiveError(`Archive entry is nested deeper than ${limits.maxPathDepth} levels`, 'limit');
  }
  return segments.join('/');
}

function parsePax(data) {
  const records = new Map();
  let position = 0;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    const length = space === -1 ? Number.NaN : Number.parseInt(data.subarray(position, space).toString('latin1'), 10);
    if (!Number.isInteger(length) || length < space - position + 3 || position + length > data.length) {
      throw new ArchiveError('Malformed pax header record', 'bad-header');
    }
    if (data[position + length - 1] !== 0x0a) {
      throw new ArchiveError('Malformed pax header record (missing newline)', 'bad-header');
    }
    const record = data.subarray(space + 1, position + length - 1);
    const equals = record.indexOf(0x3d);
    if (equals === -1) throw new ArchiveError('Malformed pax header record (missing "=")', 'bad-header');
    records.set(record.subarray(0, equals).toString('latin1'), decodeUtf8(record.subarray(equals + 1), 'A pax header value'));
    position += length;
  }
  return records;
}

const ENTRY_TYPES = Object.freeze({ 0: 'file', 7: 'file', 1: 'hardlink', 2: 'symlink', 5: 'directory' });

// Parses an uncompressed tar archive. Returns { entries, globalComment } where
// each entry is { path, type, size, mode, linkTarget, data }. `data` is a view
// into `buffer` (no copy) and only present for regular files.
export function parseTar(buffer, limits) {
  const entries = [];
  const seen = new Set();
  let globalComment = null;
  let pax = null;
  let longName = null;
  let longLink = null;
  let totalBytes = 0;
  let offset = 0;

  while (offset < buffer.length) {
    if (buffer.length - offset < BLOCK) {
      throw new ArchiveError('Archive is truncated (incomplete tar header)', 'truncated');
    }
    const header = buffer.subarray(offset, offset + BLOCK);

    if (isZeroBlock(header)) {
      // End-of-archive marker. Non-zero bytes after it would be content that
      // every extractor ignores, so refuse them rather than overlook them.
      for (let index = offset; index < buffer.length; index += 1) {
        if (buffer[index] !== 0) {
          throw new ArchiveError('Archive has data after its end-of-archive marker', 'trailing-data');
        }
      }
      break;
    }
    if (!checksumMatches(header)) {
      throw new ArchiveError('Archive has a corrupt tar header (checksum mismatch)', 'bad-header');
    }

    const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    let size = parseOctal(header.subarray(124, 136), 'size');
    if (pax?.has('size')) {
      size = Number.parseInt(pax.get('size'), 10);
      if (!Number.isInteger(size) || size < 0) throw new ArchiveError('Malformed pax size', 'bad-header');
    }

    const isMeta = typeflag === 'x' || typeflag === 'g' || typeflag === 'L' || typeflag === 'K';
    if (size > (isMeta ? MAX_META_BYTES : limits.maxFileBytes)) {
      throw new ArchiveError(`Archive entry is larger than the ${isMeta ? MAX_META_BYTES : limits.maxFileBytes} byte limit`, 'limit');
    }
    const dataStart = offset + BLOCK;
    if (dataStart + size > buffer.length) {
      throw new ArchiveError('Archive is truncated (entry data is cut off)', 'truncated');
    }
    const data = buffer.subarray(dataStart, dataStart + size);
    offset = Math.min(buffer.length, dataStart + Math.ceil(size / BLOCK) * BLOCK);

    if (typeflag === 'x') {
      pax = new Map([...(pax ?? []), ...parsePax(data)]);
      continue;
    }
    if (typeflag === 'g') {
      const global = parsePax(data);
      for (const key of global.keys()) {
        if (key !== 'comment') {
          throw new ArchiveError(`Unsupported global pax header key "${key}"`, 'unsupported-entry');
        }
      }
      globalComment = global.get('comment') ?? globalComment;
      continue;
    }
    if (typeflag === 'L') {
      longName = decodeUtf8(cString(data), 'A GNU long name');
      continue;
    }
    if (typeflag === 'K') {
      longLink = decodeUtf8(cString(data), 'A GNU long link name');
      continue;
    }

    const type = ENTRY_TYPES[typeflag];
    if (!type) {
      throw new ArchiveError(`Archive contains an unsupported entry type "${typeflag}" (devices, FIFOs and similar are not allowed)`, 'unsupported-entry');
    }

    const isUstar = header.subarray(257, 263).toString('latin1') === 'ustar\0';
    const prefix = isUstar ? decodeUtf8(cString(header.subarray(345, 500)), 'A tar path prefix') : '';
    const name = decodeUtf8(cString(header.subarray(0, 100)), 'A tar entry name');
    const rawPath = pax?.get('path') ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    const rawLink = pax?.get('linkpath') ?? longLink ?? decodeUtf8(cString(header.subarray(157, 257)), 'A tar link name');
    pax = null;
    longName = null;
    longLink = null;

    if ((type === 'directory' || type === 'symlink' || type === 'hardlink') && size > 0) {
      throw new ArchiveError(`Archive ${type} entry carries unexpected data`, 'bad-header');
    }

    const path = normalizeArchivePath(rawPath, limits);
    if (path === '' && type !== 'directory') {
      throw new ArchiveError('Archive entry has an empty path', 'unsafe-path');
    }
    if (type !== 'directory') {
      if (seen.has(path)) throw new ArchiveError(`Archive contains the same path twice: ${JSON.stringify(path)}`, 'duplicate-path');
      seen.add(path);
    }

    let linkTarget = null;
    if (type === 'symlink' || type === 'hardlink') {
      if (rawLink === '' || rawLink.includes('\0')) {
        throw new ArchiveError(`Archive ${type} has an empty or invalid target`, 'unsafe-path');
      }
      linkTarget = rawLink;
    }

    totalBytes += size;
    if (totalBytes > limits.maxUncompressedBytes) {
      throw new ArchiveError(`Archive contents exceed ${limits.maxUncompressedBytes} bytes`, 'limit');
    }
    if (entries.length >= limits.maxEntries) {
      throw new ArchiveError(`Archive has more than ${limits.maxEntries} entries`, 'limit');
    }
    entries.push({
      path,
      type,
      size: type === 'file' ? size : 0,
      mode: parseOctal(header.subarray(100, 108), 'mode') & 0o7777,
      linkTarget,
      data: type === 'file' ? data : null,
    });
  }

  return { entries, globalComment };
}

// Decompresses with a hard output cap (so a gzip bomb cannot exhaust memory),
// then parses. Throws ArchiveError on any problem.
export async function readTarGz(compressed, limits) {
  if (compressed.length > limits.maxCompressedBytes) {
    throw new ArchiveError(`Archive is larger than the ${limits.maxCompressedBytes} byte download limit`, 'limit');
  }
  if (compressed.length < 2 || compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
    throw new ArchiveError('Archive is not gzip-compressed', 'bad-gzip');
  }

  let tar;
  try {
    tar = await gunzipAsync(compressed, { maxOutputLength: limits.maxUncompressedBytes });
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ArchiveError(`Archive expands beyond ${limits.maxUncompressedBytes} bytes (possible decompression bomb)`, 'limit');
    }
    throw new ArchiveError(`Archive could not be decompressed: ${error?.message ?? error}`, 'bad-gzip');
  }

  const MIN_RATIO_CHECK_BYTES = 1024 * 1024;
  if (tar.length >= MIN_RATIO_CHECK_BYTES && tar.length / compressed.length > limits.maxCompressionRatio) {
    throw new ArchiveError(
      `Archive compression ratio exceeds ${limits.maxCompressionRatio}:1 (possible decompression bomb)`,
      'limit',
    );
  }
  return parseTar(tar, limits);
}
