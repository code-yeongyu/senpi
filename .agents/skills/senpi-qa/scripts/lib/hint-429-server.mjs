/**
 * Scripted 429 server for the hint-aware retry-tier scenarios.
 *
 * Answers the Anthropic Messages wire format so the REAL header -> canonical
 * marker path is exercised (`anthropic-messages.ts` appends
 * `(retry-after-ms: N)` only when a 429 SDK error carries response headers).
 * The primary model is rate limited for a scripted number of requests; every
 * other request streams a text marker.
 *
 * The 429 body/headers are scripted per scenario:
 *   - hinted:  `retry-after` (seconds) or `retry-after-ms` header + rate-limit body
 *   - no-hint: rate-limit body only, ZERO retry-after headers
 *
 * The probe-back scenario needs the primary to recover on its own schedule, so
 * `primaryLimitedRequests` bounds how many primary requests are refused; the
 * rest (including the scheduler's 1-token probe) succeed.
 */

import { createServer } from "node:http";
import { API_PRESETS } from "./mock-loop-support.mjs";

// Derive from the shared preset so changing the anthropic modelId in one place
// does not silently break the 429 scripted path.
export const HINT_429_PRIMARY_MODEL_ID = API_PRESETS["anthropic-messages"].modelId;
export const HINT_429_FALLBACK_MODEL_ID = "mock-claude-fallback";

// readRequestBody + writeSse are also defined in anthropic-policy-refusal-server.mjs
// and fallback-abort-server.mjs. No shared helper module exists yet; if a fourth
// call site appears, extract one.

// NOTE: readRequestBody + writeSse are duplicated from anthropic-policy-refusal-server.mjs.
// See the module-load comment above for the rationale on not extracting a shared helper yet.
function readRequestBody(request) {
	return new Promise((resolve, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => resolve(body));
		request.on("error", reject);
	});
}

/**
 * @param {{
 *   primaryLimitedRequests: number,
 *   rateLimitHeaders?: Record<string, string>,
 *   rateLimitMessage?: string,
 *   primaryMarker: string,
 *   fallbackMarker: string,
 * }} script
 */
export function startHint429Server(script) {
	if (!Number.isInteger(script.primaryLimitedRequests) || script.primaryLimitedRequests < 0) {
		throw new Error("primaryLimitedRequests must be a non-negative integer");
	}
	const requests = [];
	let primaryRefusals = 0;
	const server = createServer(async (request, response) => {
		const raw = await readRequestBody(request);
		let payload = {};
		try {
			payload = raw ? JSON.parse(raw) : {};
		} catch {}
		const isPrimary = payload.model === HINT_429_PRIMARY_MODEL_ID;
		const rateLimited = isPrimary && primaryRefusals < script.primaryLimitedRequests;
		requests.push({
			path: request.url,
			model: payload.model,
			// A max_tokens of 1 identifies the probe-back scheduler's 1-token ping.
			maxTokens: payload.max_tokens,
			rateLimited,
			atMs: Date.now(),
		});
		if (rateLimited) {
			primaryRefusals++;
			response.writeHead(429, { "content-type": "application/json", ...(script.rateLimitHeaders ?? {}) });
			response.end(
				JSON.stringify({
					type: "error",
					error: {
						type: "rate_limit_error",
						message: script.rateLimitMessage ?? "All tokens rate limited",
					},
				}),
			);
			return;
		}
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		writeTextResponse(response, payload.model, isPrimary ? script.primaryMarker : script.fallbackMarker);
		response.end();
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("hint-429 server has no TCP address"));
				return;
			}
			const origin = `http://127.0.0.1:${address.port}`;
			resolve({
				origin,
				url: `${origin}/v1`,
				port: address.port,
				requests,
				get listening() {
					return server.listening;
				},
				stop: () => new Promise((done) => server.close(() => done())),
			});
		});
	});
}

function writeTextResponse(response, model, text) {
	writeSse(response, "message_start", {
		type: "message_start",
		message: {
			id: "msg_hint_429",
			type: "message",
			role: "assistant",
			model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	});
	writeSse(response, "content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	});
	writeSse(response, "content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text },
	});
	writeSse(response, "content_block_stop", { type: "content_block_stop", index: 0 });
	writeSse(response, "message_delta", {
		type: "message_delta",
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: 1 },
	});
	writeSse(response, "message_stop", { type: "message_stop" });
}

function writeSse(response, event, data) {
	response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
