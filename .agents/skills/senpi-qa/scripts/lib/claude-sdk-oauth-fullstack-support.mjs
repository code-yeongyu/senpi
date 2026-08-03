/**
 * Shared helpers for claude-sdk-oauth-fullstack-probe.mjs.
 *
 * Kept out of the probe so each script stays under the 250 pure-LOC ceiling.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Canonical timeout helper lives in with-timeout.mjs; re-exported so existing
// probe imports keep working and no second copy of the pattern drifts.
export { withTimeout } from "./with-timeout.mjs";

/** Marker emitted by prompt-bridge.ts buildPromptBlocks when senpi flattens history. */
export const FLATTEN_MARKER = "<conversation_history>";
/** Trailer buildPromptBlocks always appends, even when there is no history yet. */
export const FLATTEN_TRAILER = "The above is the conversation history so far";

/**
 * Loopback Anthropic-messages handler for the fullstack probe.
 *
 * Route-checks POSTs (/messages only, 404 otherwise), fails closed on
 * malformed JSON or a wrong request shape (400), records byte-accurate
 * metrics through onModelRequest, and answers with the SSE fixture — a
 * wrong-route or wrong-shape request can never receive a 200 fixture and
 * manufacture false continuity evidence.
 */
/**
 * Extract concatenated text from Anthropic API messages (string or block
 * content) or SDK user messages ({message: {content}}). Used to prove the
 * classified user payload actually reached the provider on the wire.
 */
export function extractPayloadText(input) {
	const texts = [];
	const visit = (content) => {
		if (typeof content === "string") {
			texts.push(content);
			return;
		}
		if (Array.isArray(content)) {
			for (const block of content) {
				if (block && typeof block === "object" && typeof block.text === "string") texts.push(block.text);
			}
		}
	};
	for (const message of Array.isArray(input) ? input : [input]) {
		visit(message?.content ?? message?.message?.content);
	}
	return texts.join("\n");
}

export function createModelCaptureHandler(onModelRequest) {
	let count = 0;
	return (request, response) => {
		if (request.method !== "POST") {
			response.writeHead(200);
			response.end();
			return;
		}
		// Match the parsed pathname exactly (query parameters allowed): a
		// substring check would treat a mistyped route containing "/messages"
		// as a valid model request and manufacture false continuity evidence.
		const pathname = new URL(request.url ?? "/", "http://loopback.invalid").pathname;
		if (pathname !== "/v1/messages") {
			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "unknown_route" }));
			return;
		}
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			raw += chunk;
		});
		// A dropped mid-upload connection must settle the response: without an
		// error listener the 'end' handler never runs and the probe hangs to
		// the turn timeout instead of failing fast with diagnostics.
		request.on("error", () => {
			if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "request_dropped" }));
		});
		request.on("end", () => {
			let body;
			try {
				body = JSON.parse(raw);
			} catch {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: "malformed_request" }));
				return;
			}
			// JSON.parse can yield a primitive: validate the container before
			// reading properties, or a malformed body crashes the handler
			// instead of producing the fail-closed 400.
			if (typeof body !== "object" || body === null || Array.isArray(body)) {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: "malformed_shape" }));
				return;
			}
			if (typeof body.model !== "string" || !Array.isArray(body.messages)) {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: "malformed_shape" }));
				return;
			}
			count += 1;
			// Buffer.byteLength, not raw.length: the column is labeled bytes, and
			// raw.length counts UTF-16 code units, not HTTP body bytes.
			// The text digest lets the probe prove the classified payload reached
			// the wire, not just that some nonempty request arrived.
			onModelRequest({
				bytes: Buffer.byteLength(raw, "utf8"),
				messages: body.messages.length,
				text: extractPayloadText(body.messages).slice(0, 4_000),
			});
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			response.end(loopbackSseBody(`probe-reply-${count}`, count));
		});
	};
}

function payloadText(message) {
	const content = message?.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block && typeof block === "object" && typeof block.text === "string" ? block.text : ""))
		.join("\n");
}

/**
 * Classify one submitted SDK user message:
 *   flatten   - carries a rebuilt <conversation_history> transcript
 *   bootstrap - buildPromptBlocks shape with no prior history (first turn)
 *   delta     - only the new user content (the resident-session happy path)
 */
export function classifyPayload(message) {
	const text = payloadText(message);
	const bytes = Buffer.byteLength(text, "utf8");
	if (text.includes(FLATTEN_MARKER)) return { kind: "flatten", bytes };
	if (text.includes(FLATTEN_TRAILER)) return { kind: "bootstrap", bytes };
	return { kind: "delta", bytes };
}

export function formatTurnTable(turns) {
	const header = ["turn", "queries", "path", "payload", "bytes", "wire_reqs", "wire_bytes", "lineage"];
	const rows = turns.map((turn) => [
		String(turn.index),
		String(turn.queries),
		turn.path,
		turn.kind,
		String(turn.bytes),
		String(turn.wireRequests),
		String(turn.wireBytes),
		String(turn.lineage).slice(0, 8),
	]);
	const widths = header.map((label, column) =>
		Math.max(label.length, ...rows.map((row) => row[column].length), 0),
	);
	const line = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
	return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line), ""].join("\n");
}

/** SSE body the loopback server returns for one Anthropic /v1/messages request. */
export function loopbackSseBody(text, sequence) {
	const events = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: `msg_fullstack_probe_${sequence}`,
					type: "message",
					role: "assistant",
					model: "claude-haiku-4-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 0 },
				},
			},
		],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 2 },
			},
		],
		["message_stop", { type: "message_stop" }],
	];
	return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

/**
 * Seed the sandbox agent dir with a DUMMY claude-sdk-oauth credential so the
 * provider counts as configured. The token is never used: the Claude Code
 * subprocess talks only to the loopback server.
 */
export function seedProbeAgentDir(agentDir) {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({
			"claude-sdk-oauth": {
				type: "oauth",
				access: "fullstack-probe-dummy-access",
				refresh: "fullstack-probe-dummy-refresh",
				expires: Date.now() + 3_600_000,
			},
		}),
		{ mode: 0o600 },
	);
}
