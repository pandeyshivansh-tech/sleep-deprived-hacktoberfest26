import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeHealth } from '../src/lib/health.js';

const baseHealth = {
  status: 'ok',
  version: '0.1.0',
  ollama: { baseUrl: 'http://127.0.0.1:11434', reachable: true, latencyMs: 4, error: null },
  models: [
    { name: 'gemma4:e4b', role: 'classification', installed: true, digest: 'a' },
    { name: 'deepseek-r1:8b', role: 'investigation', installed: true, digest: 'b' },
  ],
  ai: { ready: true },
};

test('everything available', () => {
  const view = describeHealth({ health: baseHealth, error: null });
  assert.equal(view.server.state, 'ok');
  assert.equal(view.ollama.state, 'ok');
  assert.deepEqual(view.models.map((m) => m.state), ['ok', 'ok']);
  assert.equal(view.ai.ready, true);
});

test('a missing model shows the pull command', () => {
  const health = {
    ...baseHealth,
    models: [baseHealth.models[0], { ...baseHealth.models[1], installed: false }],
    ai: { ready: false },
  };
  const view = describeHealth({ health, error: null });
  assert.equal(view.models[1].state, 'missing');
  assert.match(view.models[1].label, /ollama pull deepseek-r1:8b/);
  assert.match(view.ai.label, /install the missing models/);
});

test('Ollama unreachable leaves model status unknown', () => {
  const health = {
    ...baseHealth,
    ollama: { ...baseHealth.ollama, reachable: false, latencyMs: null, error: 'Could not connect to Ollama: fetch failed' },
    models: baseHealth.models.map((m) => ({ ...m, installed: null })),
    ai: { ready: false },
  };
  const view = describeHealth({ health, error: null });
  assert.equal(view.server.state, 'ok');
  assert.equal(view.ollama.state, 'down');
  assert.equal(view.ollama.detail, 'Could not connect to Ollama: fetch failed');
  assert.deepEqual(view.models.map((m) => m.state), ['unknown', 'unknown']);
  assert.match(view.ai.label, /start Ollama/);
});

test('before the first response arrives, nothing is reported as down', () => {
  const view = describeHealth({ health: null, error: null });
  assert.equal(view.server.state, 'unknown');
  assert.equal(view.server.label, 'Checking…');
  assert.equal(view.ai.ready, false);
});

test('server unreachable', () => {
  const view = describeHealth({ health: null, error: 'Failed to fetch' });
  assert.equal(view.server.state, 'down');
  assert.equal(view.server.detail, 'Failed to fetch');
  assert.deepEqual(view.models, []);
  assert.equal(view.ai.ready, false);
});
