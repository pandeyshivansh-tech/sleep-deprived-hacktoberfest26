import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp({ ollamaBaseUrl: config.ollamaBaseUrl });

app.listen(config.port, config.host, () => {
  console.log(`PackageLens server listening on http://${config.host}:${config.port}`);
  console.log(`Using local Ollama at ${config.ollamaBaseUrl}`);
});
