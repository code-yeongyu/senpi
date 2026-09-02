import { createServer } from "node:net";

// The lane reads PI_OAUTH_CALLBACK_HOST at module load; pin the default so the
// blocker below occupies the exact address the login will try to bind.
const host = "127.0.0.1";
const port = 53692;
process.env.PI_OAUTH_CALLBACK_HOST = host;
const { anthropicOAuth } = await import("../../../../packages/ai/src/auth/oauth/anthropic.ts");

let listener;
let authUrl;
let manualPromptSeen = false;

try {
	listener = createServer();
	await new Promise((resolve, reject) => {
		listener.once("error", reject);
		listener.listen(port, host, resolve);
	});
	const fetchCalls = [];
	globalThis.fetch = async (_input, init) => {
		fetchCalls.push(JSON.parse(init.body));
		return new Response(JSON.stringify({ access_token: "probe-access", refresh_token: "probe-refresh", expires_in: 3600 }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};
	const credential = await anthropicOAuth.login({
		signal: new AbortController().signal,
		notify: (event) => {
			if (event.type === "auth_url") authUrl = event;
		},
		prompt: async (prompt) => {
			if (prompt.type !== "manual_code") throw new Error(`unexpected prompt ${prompt.type}`);
			manualPromptSeen = true;
			if (!authUrl) throw new Error("manual prompt arrived before auth_url");
			const url = new URL(authUrl.url);
			return `${url.searchParams.get("redirect_uri")}?code=probe-code&state=${url.searchParams.get("state")}`;
		},
	});
	const instructions = authUrl?.instructions ?? "";
	const guidanceOk = instructions.includes(String(port)) && /redirect URL/i.test(instructions) && /EADDRINUSE|EACCES|EPERM/.test(instructions);
	const redirectOk = fetchCalls[0]?.redirect_uri === `http://localhost:${port}/callback`;
	const passed = authUrl && manualPromptSeen && credential.access === "probe-access" && fetchCalls.length === 1 && guidanceOk && redirectOk;
	if (!passed) {
		throw new Error(
			`auth_url=${Boolean(authUrl)} manualPrompt=${manualPromptSeen} credential=${credential?.access === "probe-access"} fetchCalls=${fetchCalls.length} guidanceOk=${guidanceOk} redirectOk=${redirectOk} instructions=${JSON.stringify(instructions)}`,
		);
	}
	console.log(`PASS auth_url + manual_code + credential; callback port ${port}; redirect_uri ${fetchCalls[0].redirect_uri}`);
} catch (error) {
	console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	if (listener) {
		await new Promise((resolve) => listener.close(resolve));
		console.log(`CLEANUP closed pre-bound listener on ${host}:${port}`);
	}
}
