// A fake fetch for tests: nothing touches the network. Routes map an exact URL
// to a response description, and unknown URLs return 404. Every requested URL
// is recorded so tests can assert what was (and was not) requested.
export function makeFakeFetch(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const route = routes[String(url)];
    if (route === undefined) return new Response('not found', { status: 404 });
    if (route instanceof Error) throw route;
    if (typeof route === 'function') return route(String(url), options);

    const { status = 200, body = '', headers = {} } = route;
    let payload = body;
    if (payload !== null && typeof payload === 'object' && !Buffer.isBuffer(payload)) {
      payload = JSON.stringify(payload);
    }
    const nullBody = status === 204 || (status >= 300 && status < 400);
    return new Response(nullBody ? null : payload, { status, headers });
  };
  return { fetchImpl, calls, urls: () => calls.map((call) => call.url) };
}
