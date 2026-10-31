import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_MODELS, loadConfig, resolveOllamaBaseUrl } from '../src/config.js';

test('the product requires exactly gemma4:e4b and deepseek-r1:8b', () => {
  assert.deepEqual(
    REQUIRED_MODELS.map((model) => [model.name, model.role]),
    [
      ['gemma4:e4b', 'classification'],
      ['deepseek-r1:8b', 'investigation'],
    ],
  );
});

test('defaults to local Ollama and a loopback-only server', () => {
  const config = loadConfig({});
  assert.equal(config.ollamaBaseUrl, 'http://127.0.0.1:11434');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
});

test('accepts loopback Ollama hosts', () => {
  assert.equal(resolveOllamaBaseUrl('http://localhost:11434/'), 'http://localhost:11434');
  assert.equal(resolveOllamaBaseUrl('http://[::1]:11434'), 'http://[::1]:11434');
});

test('rejects non-local Ollama hosts so inference never leaves the machine', () => {
  assert.throws(() => resolveOllamaBaseUrl('https://ollama.example.com'), /local Ollama/);
  assert.throws(() => resolveOllamaBaseUrl('http://10.0.0.5:11434'), /local Ollama/);
  assert.throws(() => resolveOllamaBaseUrl('file:///etc/passwd'), /http or https/);
  assert.throws(() => resolveOllamaBaseUrl('not a url'), /not a valid URL/);
});

test('rejects an invalid port', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ PORT: '70000' }), /PORT/);
});
