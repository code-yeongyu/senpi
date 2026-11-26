import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";

export interface LoopbackServer {
	readonly url: string;
	readonly requests: string[];
	close(): Promise<void>;
}

function streamChatCompletion(write: (chunk: string) => void): void {
	const base = { id: "chatcmpl-loopback", object: "chat.completion.chunk", created: 0, model: "loopback" };
	write(
		`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`,
	);
	write(
		`data: ${JSON.stringify({
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		})}\n\n`,
	);
	write("data: [DONE]\n\n");
}

/** `/chat/completions` streams one text reply; any other path answers 404 after being recorded. */
export function startLoopbackServer(): Promise<LoopbackServer> {
	const requests: string[] = [];
	const server: Server = createServer((request, response) => {
		requests.push(request.url ?? "");
		request.resume();
		request.on("end", () => {
			if (request.url?.endsWith("/chat/completions")) {
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				streamChatCompletion((chunk) => response.write(chunk));
				response.end();
				return;
			}
			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "loopback: no such route" } }));
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${port}/v1`,
				requests,
				close: () => new Promise((done) => server.close(() => done())),
			});
		});
	});
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface FetchGuard {
	readonly blocked: string[];
}

/**
 * Replaces global `fetch` so every non-loopback request is refused and recorded: a provider
 * that ignores the configured baseUrl can never reach a real host from a test. Undo with
 * `vi.unstubAllGlobals()`.
 */
export function installLoopbackFetchGuard(): FetchGuard {
	const original = globalThis.fetch;
	const blocked: string[] = [];
	vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		if (!LOOPBACK_HOSTS.has(url.hostname)) {
			blocked.push(url.origin);
			return Promise.reject(new Error(`non-loopback fetch refused by the test guard: ${url.origin}`));
		}
		return original(input, init);
	});
	return { blocked };
}
