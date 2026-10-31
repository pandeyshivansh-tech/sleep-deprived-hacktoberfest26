import { REQUIRED_MODELS } from './config.js';
import { listInstalledModels } from './ai/ollama.js';

// Server health is independent of Ollama: the deterministic analysis does not
// need a model, so an unreachable Ollama degrades only the AI features.
export async function getHealth({ ollamaBaseUrl, fetchImpl, version }) {
  const ollama = await listInstalledModels({ baseUrl: ollamaBaseUrl, fetchImpl });

  // Exact tag match: a different size or quantization is a different model.
  const installed = new Map(ollama.models.map((model) => [model.name, model]));
  const models = REQUIRED_MODELS.map(({ name, role }) => {
    const match = installed.get(name);
    return {
      name,
      role,
      // Unknown (null) rather than false when Ollama cannot be asked.
      installed: ollama.reachable ? Boolean(match) : null,
      digest: match?.digest ?? null,
    };
  });

  return {
    status: 'ok',
    service: 'audyssey-server',
    version,
    ollama: {
      baseUrl: ollamaBaseUrl,
      reachable: ollama.reachable,
      latencyMs: ollama.latencyMs,
      error: ollama.error,
    },
    models,
    ai: { ready: ollama.reachable && models.every((model) => model.installed === true) },
  };
}
