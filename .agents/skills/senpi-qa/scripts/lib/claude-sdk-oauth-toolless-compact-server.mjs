/**
 * Loopback Anthropic server for the tool-less compaction probe.
 *
 * Answers only `POST .../v1/messages` bodies that carry a `messages` array;
 * anything else is rejected (404/400) and never recorded, so a mis-routed or
 * malformed request cannot masquerade as a model reply in the evidence.
 */

import { createServer } from "node:http";
import { loopbackSseBody } from "./claude-sdk-oauth-fullstack-support.mjs";
import { track } from "./common.mjs";

export function toolUseSseBody(toolName, sequence, modelId) {
	const input = JSON.stringify({ file_path: "/dev/null" });
	const events = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: `msg_toolless_probe_${sequence}`,
					type: "message",
					role: "assistant",
					model: modelId,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 0 },
				},
			},
		],
		[
			"content_block_start",
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: `toolu_probe_${sequence}`, name: toolName, input: {} },
			},
		],
		[
			"content_block_delta",
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: input } },
		],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 8 } },
		],
		["message_stop", { type: "message_stop" }],
	];
	return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function parseMessagesBody(raw) {
	let body;
	try {
		body = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body) || !Array.isArray(body.messages)) return undefined;
	return body;
}

/**
 * @param {{ mode: "toolless" | "always-tool", modelId: string, summaryText: string, getPhase: () => "seed" | "compact" }} input
 * @returns {Promise<{ server: import("node:http").Server, baseUrl: string, requests: object[], rejected: object[] }>}
 */
export function startToollessCompactServer(input) {
	const requests = [];
	const rejected = [];
	return new Promise((resolve, reject) => {
		const server = track(
			createServer((request, response) => {
				const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
				if (request.method !== "POST" || pathname !== "/v1/messages") {
					rejected.push({ method: request.method, pathname, reason: "route" });
					response.writeHead(404);
					response.end();
					return;
				}
				let raw = "";
				let failed = false;
				request.setEncoding("utf8");
				request.on("data", (chunk) => {
					raw += chunk;
				});
				// A client that drops mid-body must fail closed as a recorded rejection,
				// never as silence the probe would wait on.
				request.on("error", (error) => {
					if (failed) return;
					failed = true;
					rejected.push({ method: request.method, pathname, reason: `request-error:${error?.code ?? error?.message ?? "unknown"}` });
					if (!response.headersSent) response.writeHead(400);
					response.end();
				});
				request.on("aborted", () => {
					if (failed) return;
					failed = true;
					rejected.push({ method: request.method, pathname, reason: "aborted" });
				});
				request.on("end", () => {
					if (failed) return;
					const body = parseMessagesBody(raw);
					if (!body) {
						rejected.push({ method: request.method, pathname, reason: "body" });
						response.writeHead(400);
						response.end();
						return;
					}
					const phase = input.getPhase();
					const tools = Array.isArray(body.tools) ? body.tools : [];
					const sequence = requests.length + 1;
					const toolNames = tools.map((tool) => tool?.name).filter((name) => typeof name === "string");
					const entry = {
						sequence,
						phase,
						hasTools: tools.length > 0,
						toolCount: tools.length,
						toolNames: toolNames.slice(0, 12),
						bytes: Buffer.byteLength(raw, "utf8"),
						reply: "text",
					};
					let sse;
					if (phase === "compact" && (input.mode === "always-tool" || tools.length > 0)) {
						// The hijack: a summarizer that is OFFERED tools calls one. Pick an
						// offered tool when there is one so the CLI routes it through the
						// host-denial hook exactly as production would.
						const toolName = toolNames.find((name) => name === "Read") ?? toolNames[0] ?? "Read";
						entry.reply = `tool_use:${toolName}`;
						sse = toolUseSseBody(toolName, sequence, input.modelId);
					} else {
						sse = loopbackSseBody(phase === "compact" ? input.summaryText : `TOKEN_T${sequence}`, sequence);
					}
					requests.push(entry);
					response.writeHead(200, {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						connection: "keep-alive",
					});
					response.end(sse);
				});
			}),
		);
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve({ server, baseUrl: `http://127.0.0.1:${address.port}`, requests, rejected });
		});
	});
}
