// A fake local Ollama for tests: nothing touches a real model. It serves
// /api/tags and /api/chat, records every request, and lets a test script each
// model's answer. It also tracks concurrency, so tests can prove the two models
// are never called at the same time.
export function makeFakeOllama({
  installed = [
    { name: 'gemma4:e4b', digest: 'sha256:gemma-digest' },
    { name: 'deepseek-r1:8b', digest: 'sha256:deepseek-digest' },
  ],
  reachable = true,
  answers = {},
} = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ url: String(url), path, options });
    if (!reachable) throw new TypeError('fetch failed');
    if (path === '/api/tags') return new Response(JSON.stringify({ models: installed }), { status: 200 });
    if (path !== '/api/chat') return new Response('not found', { status: 404 });

    const body = JSON.parse(options.body);
    const call = { model: body.model, system: body.messages[0].content, user: body.messages[1].content, body };
    calls[calls.length - 1].chat = call;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5)); // give an overlapping call time to show up
      const answer = answers[body.model];
      const result = typeof answer === 'function' ? answer(call) : answer;
      if (result instanceof Response) return result;
      if (result instanceof Error) throw result;
      return new Response(JSON.stringify({ model: body.model, message: { role: 'assistant', content: result ?? '[]' }, done: true, done_reason: 'stop', eval_count: 10 }), { status: 200 });
    } finally {
      inFlight -= 1;
    }
  };

  return {
    fetchImpl,
    calls,
    chats: () => calls.filter((call) => call.chat).map((call) => call.chat),
    maxInFlight: () => maxInFlight,
  };
}

// File ids and finding ids as the prompts present them.
export const fileIdsIn = (prompt) => [...prompt.matchAll(/<<<FILE id=(\S+)/g)].map((m) => m[1]);
export const findingIdsIn = (prompt) => [...prompt.matchAll(/<<<FINDING id=(\S+)/g)].map((m) => m[1]);
