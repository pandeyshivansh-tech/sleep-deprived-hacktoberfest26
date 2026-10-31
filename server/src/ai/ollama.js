import { AudysseyError } from '../errors.js';
import { resolveOllamaBaseUrl } from '../config.js';

const DEFAULT_TIMEOUT_MS = 2000;

// Lists locally installed models via GET /api/tags. This endpoint only reads
// the model registry on disk: it never loads a model into memory or runs
// inference, so it is safe to call on every health check.
export async function listInstalledModels({ baseUrl, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const started = performance.now();
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : error?.message ?? String(error);
    return { reachable: false, error: `Could not connect to Ollama: ${reason}`, latencyMs: null, models: [] };
  }
  const latencyMs = Math.round(performance.now() - started);

  if (!response.ok) {
    return { reachable: false, error: `Ollama responded with HTTP ${response.status}`, latencyMs, models: [] };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { reachable: false, error: 'Ollama returned a response that is not valid JSON', latencyMs, models: [] };
  }
  if (!Array.isArray(body?.models)) {
    return { reachable: false, error: 'Ollama response is missing the models list', latencyMs, models: [] };
  }

  const models = body.models
    .map((model) => ({
      name: typeof model?.name === 'string' ? model.name : model?.model,
      digest: typeof model?.digest === 'string' ? model.digest : null,
    }))
    .filter((model) => typeof model.name === 'string');

  return { reachable: true, error: null, latencyMs, models };
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

export class OllamaError extends AudysseyError {}

const MAX_RESPONSE_CHARS = 200_000;

// Reasoning models wrap their thinking in <think>...</think>. It is not an answer
// and can contain anything, so it is removed before the text is parsed. An
// unclosed tag (the model ran out of tokens while thinking) drops the rest.
export function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim();
}

// One non-streaming chat call to the LOCAL Ollama. There is no other inference
// path in the product: the base URL is re-checked to be loopback on every call,
// and `keep_alive: 0` unloads the model afterwards so the two models never share
// memory (they would not fit together on a 16 GB laptop).
export async function chat({
  baseUrl,
  model,
  system,
  user,
  think,
  numPredict,
  numCtx = 8192,
  timeoutMs = 240_000,
  fetchImpl = fetch,
}) {
  const origin = resolveOllamaBaseUrl(baseUrl);
  const body = {
    model,
    stream: false,
    keep_alive: 0,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    // Fixed seed and temperature 0: the same input gives the same output.
    options: { temperature: 0, seed: 7, num_predict: numPredict, num_ctx: numCtx },
  };
  if (think !== undefined) body.think = think;

  const started = performance.now();
  let response;
  try {
    response = await fetchImpl(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? `timed out after ${Math.round(timeoutMs / 1000)} s` : error?.message ?? String(error);
    throw new OllamaError(`Ollama request for ${model} failed: ${reason}`, error?.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  if (!response.ok) {
    throw new OllamaError(`Ollama responded with HTTP ${response.status} for ${model}`, 'http', { status: response.status });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new OllamaError(`Ollama returned a response for ${model} that is not valid JSON`, 'bad-response');
  }
  const raw = payload?.message?.content;
  if (typeof raw !== 'string') throw new OllamaError(`Ollama returned no message for ${model}`, 'bad-response');

  return {
    content: stripThinking(raw.slice(0, MAX_RESPONSE_CHARS)),
    // The model stopped because it hit the token limit, so its answer may be cut off.
    truncated: payload.done_reason === 'length',
    durationMs: Math.round(performance.now() - started),
    evalCount: Number.isInteger(payload.eval_count) ? payload.eval_count : null,
  };
}

// Model output is untrusted text. This finds the first JSON array in it (models
// add prose or code fences) and returns the parsed value, or null.
export function extractJsonArray(text) {
  const candidates = [text, text.replace(/```(?:json)?/gi, '')];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
