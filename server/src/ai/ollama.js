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
