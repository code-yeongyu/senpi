// EQ fixture extension: keeps an example extension that talks to fixed internet hosts offline, without editing it.
//
// The example provider extensions (E26 custom-provider-anthropic, E27 custom-provider-gitlab-duo) name their hosts in
// code, so a models.json `baseUrl` cannot redirect them. This fixture is loaded before them and wraps the process's
// `fetch`:
// - a request to an origin listed in EQ_ROUTE_ORIGINS (comma-separated) goes to the fake model server instead
//   (`EQ_BARRIER_ORIGIN`), with its path and query unchanged, so the route is still observed (O1/O2);
// - a request whose `<METHOD> <url>` is a key of EQ_LOCAL_RESPONSES (JSON) is answered here with that JSON body: a
//   provider's own token exchange (E27 GitLab direct access), which is not a model request and must not consume a
//   scripted turn;
// - a request to a loopback host passes through unchanged (the fake servers);
// - every other request is refused with an error naming it, so no case can reach the network by accident.
// It changes nothing else: no tool, no hook, no provider is registered.

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function requestUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

export default function offlineNetwork() {
	const origin = process.env.EQ_BARRIER_ORIGIN;
	const routed = (process.env.EQ_ROUTE_ORIGINS ?? "").split(",").filter(Boolean);
	const local = JSON.parse(process.env.EQ_LOCAL_RESPONSES ?? "{}");
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = new URL(requestUrl(input));
		const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
		const answer = local[`${method} ${url.origin}${url.pathname}`];
		if (answer !== undefined)
			return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
		if (routed.includes(url.origin)) {
			const target = `${origin}${url.pathname}${url.search}`;
			return input instanceof Request ? realFetch(new Request(target, input), init) : realFetch(target, init);
		}
		if (LOOPBACK.has(url.hostname)) return realFetch(input, init);
		throw new TypeError(`EQ offline: refused ${method} ${url.origin}${url.pathname}`);
	};
}
