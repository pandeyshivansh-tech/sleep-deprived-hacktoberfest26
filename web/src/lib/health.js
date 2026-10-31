// Turns the /api/health response (or a failure to fetch it) into what the
// status panel displays. Kept free of React so it can be tested with node:test.

const ROLE_LABELS = {
  classification: 'Difference classification',
  investigation: 'Security investigation',
};

function describeModel(model, ollamaReachable) {
  const role = ROLE_LABELS[model.role] ?? model.role;
  if (!ollamaReachable || model.installed === null) {
    return { name: model.name, role, state: 'unknown', label: 'Unknown: Ollama is not reachable' };
  }
  if (model.installed) {
    return { name: model.name, role, state: 'ok', label: 'Installed' };
  }
  return { name: model.name, role, state: 'missing', label: `Not installed. Run: ollama pull ${model.name}` };
}

export function describeHealth({ health, error }) {
  if (!health && !error) {
    return {
      server: { state: 'unknown', label: 'Checking…', detail: null },
      ollama: { state: 'unknown', label: 'Checking…', detail: null },
      models: [],
      ai: { ready: false, label: 'Checking…' },
    };
  }
  if (error || !health) {
    return {
      server: { state: 'down', label: 'Cannot reach the Audyssey server', detail: error ?? null },
      ollama: { state: 'unknown', label: 'Unknown', detail: null },
      models: [],
      ai: { ready: false, label: 'Unknown until the server is reachable' },
    };
  }

  const ollamaReachable = health.ollama?.reachable === true;
  const models = (health.models ?? []).map((model) => describeModel(model, ollamaReachable));
  const ready = health.ai?.ready === true;

  let aiLabel = 'Both local models are available';
  if (!ollamaReachable) aiLabel = 'Unavailable: start Ollama to enable AI explanations';
  else if (!ready) aiLabel = 'Unavailable: install the missing models';

  return {
    server: { state: 'ok', label: `Running (v${health.version})`, detail: null },
    ollama: ollamaReachable
      ? { state: 'ok', label: 'Connected', detail: `${health.ollama.baseUrl} · ${health.ollama.latencyMs} ms` }
      : { state: 'down', label: 'Not reachable', detail: health.ollama?.error ?? null },
    models,
    ai: { ready, label: aiLabel },
  };
}
