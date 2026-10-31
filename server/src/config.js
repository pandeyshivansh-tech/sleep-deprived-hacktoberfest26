// The only models the product uses. Both run locally through Ollama; there is
// no cloud inference provider and no fallback.
export const REQUIRED_MODELS = Object.freeze([
  Object.freeze({ name: 'gemma4:e4b', role: 'classification' }),
  Object.freeze({ name: 'deepseek-r1:8b', role: 'investigation' }),
]);

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Inference must stay on this machine, so a non-loopback Ollama host is a
// configuration error rather than something to silently accept.
export function resolveOllamaBaseUrl(value = DEFAULT_OLLAMA_BASE_URL) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`OLLAMA_BASE_URL is not a valid URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`OLLAMA_BASE_URL must use http or https: ${value}`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`OLLAMA_BASE_URL must point to a local Ollama instance (localhost, 127.0.0.1 or [::1]): ${value}`);
  }
  return url.origin;
}

export function loadConfig(env = process.env) {
  const port = Number.parseInt(env.PORT ?? '8787', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535: ${env.PORT}`);
  }
  return {
    port,
    host: env.HOST ?? '127.0.0.1',
    ollamaBaseUrl: resolveOllamaBaseUrl(env.OLLAMA_BASE_URL || undefined),
  };
}
