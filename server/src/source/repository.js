// Turns the (untrusted) `repository` field of a package.json into a GitHub
// owner/repo plus an optional monorepo subdirectory. Anything else is reported
// as unsupported, never guessed at.

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);

const unsupported = (reason) => ({ ok: false, reason });

function normalizeDirectory(value) {
  if (value === undefined || value === null || value === '') return { directory: null };
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0') || value.startsWith('/')) {
    return { error: 'The repository.directory field is not a safe relative path' };
  }
  const segments = [];
  for (const segment of value.split('/')) {
    if (segment === '..') return { error: 'The repository.directory field is not a safe relative path' };
    if (segment !== '' && segment !== '.') segments.push(segment);
  }
  return { directory: segments.length > 0 ? segments.join('/') : null };
}

function ownerAndRepo(pathname) {
  const [owner, rawRepo] = pathname.split('/').filter(Boolean);
  const repo = rawRepo?.replace(/\.git$/, '');
  if (!owner || !repo || !OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

export function parseRepository(repository) {
  let text;
  let rawDirectory;
  if (typeof repository === 'string') {
    text = repository;
  } else if (repository && typeof repository === 'object' && typeof repository.url === 'string') {
    text = repository.url;
    rawDirectory = repository.directory;
  } else {
    return unsupported('The package metadata has no repository field');
  }

  const { directory, error } = normalizeDirectory(rawDirectory);
  if (error) return unsupported(error);

  const value = text.trim().replace(/#.*$/, '');
  let found = null;

  const shorthand = /^(?:github:)?([^/\s:@]+)\/([^/\s:@]+)$/.exec(value);
  const scp = /^[\w.-]+@github\.com:(.+)$/.exec(value);
  if (shorthand) {
    found = ownerAndRepo(`${shorthand[1]}/${shorthand[2]}`);
  } else if (scp) {
    found = ownerAndRepo(scp[1]);
  } else {
    let url;
    try {
      url = new URL(value.replace(/^git\+/, ''));
    } catch {
      return unsupported(`The repository URL could not be understood: ${text.slice(0, 120)}`);
    }
    if (!['https:', 'http:', 'git:', 'ssh:'].includes(url.protocol)) {
      return unsupported(`The repository URL uses an unsupported protocol: ${url.protocol}`);
    }
    if (!GITHUB_HOSTS.has(url.hostname)) {
      return unsupported(`Only GitHub repositories are supported (this one is hosted on ${url.hostname})`);
    }
    found = ownerAndRepo(url.pathname);
  }

  if (!found) return unsupported(`The repository URL is not a valid GitHub owner/repo: ${text.slice(0, 120)}`);
  return { ok: true, host: 'github.com', ...found, directory, url: `https://github.com/${found.owner}/${found.repo}` };
}
