import { FetchError } from '../errors.js';
import { NETWORK_LIMITS } from '../limits.js';

// Every outbound request goes through here. Package metadata is untrusted, so a
// tarball or repository URL taken from it must not be able to steer us to an
// arbitrary host.
export const ALLOWED_HOSTS = Object.freeze(['registry.npmjs.org', 'codeload.github.com', 'github.com']);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function checkUrl(value, allowedHosts) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new FetchError(`Refusing to fetch an invalid URL: ${String(value).slice(0, 200)}`, 'bad-url');
  }
  if (url.protocol !== 'https:') {
    throw new FetchError(`Refusing to fetch a non-HTTPS URL: ${url.origin}`, 'bad-url');
  }
  if (url.username || url.password || url.port) {
    throw new FetchError(`Refusing to fetch a URL with credentials or a custom port: ${url.host}`, 'bad-url');
  }
  if (!allowedHosts.includes(url.hostname)) {
    throw new FetchError(`Refusing to fetch from a host that is not allowed: ${url.hostname}`, 'disallowed-host');
  }
  return url;
}

async function readBodyBounded(response, maxBytes, url) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new FetchError(`Response from ${url.host} is larger than the ${maxBytes} byte limit`, 'too-large');
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new FetchError(`Response from ${url.host} is larger than the ${maxBytes} byte limit`, 'too-large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// Returns the response body as a Buffer. Redirects are followed manually so each
// hop is re-checked against the allowlist. Non-2xx responses throw a FetchError
// whose `details.status` carries the HTTP status.
export async function safeFetchBuffer(
  url,
  {
    fetchImpl = fetch,
    maxBytes,
    timeoutMs = NETWORK_LIMITS.timeoutMs,
    maxRedirects = NETWORK_LIMITS.maxRedirects,
    allowedHosts = ALLOWED_HOSTS,
    headers = {},
  },
) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes is required');

  let current = checkUrl(url, allowedHosts);
  const signal = AbortSignal.timeout(timeoutMs);

  for (let hops = 0; ; hops += 1) {
    let response;
    try {
      response = await fetchImpl(current.href, { redirect: 'manual', signal, headers });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new FetchError(`Request to ${current.host} timed out after ${timeoutMs} ms`, 'timeout');
      }
      throw new FetchError(`Request to ${current.host} failed: ${error?.message ?? error}`, 'network');
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      if (hops >= maxRedirects) {
        throw new FetchError(`Too many redirects from ${current.host}`, 'too-many-redirects');
      }
      const location = response.headers.get('location');
      if (!location) throw new FetchError(`Redirect from ${current.host} has no location`, 'bad-redirect');
      current = checkUrl(new URL(location, current).href, allowedHosts);
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new FetchError(`${current.host} responded with HTTP ${response.status}`, 'http', {
        status: response.status,
      });
    }

    try {
      return await readBodyBounded(response, maxBytes, current);
    } catch (error) {
      if (error instanceof FetchError) throw error;
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new FetchError(`Download from ${current.host} timed out after ${timeoutMs} ms`, 'timeout');
      }
      throw new FetchError(`Download from ${current.host} failed: ${error?.message ?? error}`, 'network');
    }
  }
}
