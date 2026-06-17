/**
 * Deterministic multi-protocol fake model server for mock-loop QA.
 *
 * senpi reaches a provider via `model.baseUrl`, so pointing baseUrl at this
 * server lets the real CLI run a full agent turn with ZERO real API calls. It
 * answers the three wire formats senpi actually uses, selected by request path:
 *   - `/chat/completions`  -> OpenAI chat completions (api "openai-completions")
 *   - `/messages`          -> Anthropic Messages       (api "anthropic-messages")
 *   - `/responses`         -> OpenAI Responses         (api "openai-responses")
 *
 * Turns are scripted protocol-independently ({ text?, toolCalls? }); each
 * handler renders the matching SSE. Run `node fake-model-server.mjs --self-test`.
 */

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;

/**
 * @param {{ port?: number, turns?: Array<{text?:string, toolCalls?:Array<{id?:string,name:string,args:object}>}> }} opts
 * @returns {Promise<{url:string, origin:string, port:number, requests:object[], stop:()=>Promise<void>}>}
 */
export function startFakeModelServer({ port = 0, turns = [{ text: "OK" }] } = {}) {
	const requests = [];
	let callIndex = 0;

	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			let body = {};
			try {
				body = raw ? JSON.parse(raw) : {};
			} catch {}
			requests.push({
				method: req.method,
				url: req.url,
				authorization: req.headers.authorization || null,
				apiKeyHeader: req.headers["x-api-key"] || null,
				model: body.model,
				stream: !!body.stream,
				messages: body.messages,
			});

			const url = req.url || "";
			if (req.method === "GET" && url.includes("/models")) {
				return sendJson(res, 200, { object: "list", data: [{ id: body.model || "mock", object: "model" }] });
			}

			const turn = turns[Math.min(callIndex, turns.length - 1)] || { text: "OK" };
			callIndex++;
			const modelId = body.model || "mock";

			if (url.includes("/chat/completions")) return writeCompletionsSse(res, turn, modelId);
			if (url.includes("/messages")) return writeAnthropicSse(res, turn, modelId);
			if (url.includes("/responses")) return writeResponsesSse(res, turn, modelId);
			return sendJson(res, 404, { error: { message: `no route: ${req.method} ${url}` } });
		});
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			const actual = server.address().port;
			const origin = `http://127.0.0.1:${actual}`;
			resolve({
				url: `${origin}/v1`,
				origin,
				port: actual,
				requests,
				stop: () => new Promise((r) => server.close(() => r())),
			});
		});
	});
}

function sendJson(res, status, obj) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(obj));
}

function sseHead(res) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
}

// --- OpenAI chat completions ---------------------------------------------
function writeCompletionsSse(res, turn, modelId) {
	sseHead(res);
	const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model: modelId };
	const send = (delta, finish = null) =>
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
	const tcs = (turn.toolCalls || []).map((tc, i) => ({
		index: i,
		id: tc.id || `call_${i + 1}`,
		type: "function",
		function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
	}));
	send({ role: "assistant", content: "" });
	if (turn.text) send({ content: turn.text });
	if (tcs.length) send({ tool_calls: tcs });
	send({}, tcs.length ? "tool_calls" : "stop");
	res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
}

// --- Anthropic Messages ---------------------------------------------------
function writeAnthropicSse(res, turn, modelId) {
	sseHead(res);
	const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
	ev("message_start", {
		message: { id: "msg_mock", type: "message", role: "assistant", model: modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
	});
	let index = 0;
	if (turn.text) {
		ev("content_block_start", { index, content_block: { type: "text", text: "" } });
		ev("content_block_delta", { index, delta: { type: "text_delta", text: turn.text } });
		ev("content_block_stop", { index });
		index++;
	}
	for (const tc of turn.toolCalls || []) {
		ev("content_block_start", { index, content_block: { type: "tool_use", id: tc.id || `toolu_${index}`, name: tc.name, input: {} } });
		ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tc.args ?? {}) } });
		ev("content_block_stop", { index });
		index++;
	}
	const stopReason = (turn.toolCalls || []).length ? "tool_use" : "end_turn";
	ev("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } });
	ev("message_stop", {});
	res.end();
}

// --- OpenAI Responses -----------------------------------------------------
function writeResponsesSse(res, turn, modelId) {
	sseHead(res);
	let seq = 0;
	const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
	const respId = "resp_mock";
	ev("response.created", { response: { id: respId, object: "response", status: "in_progress", model: modelId, output: [] } });
	let outputIndex = 0;
	const outputItems = [];
	if (turn.text) {
		const itemId = "msg_mock";
		ev("response.output_item.added", { output_index: outputIndex, item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] } });
		ev("response.content_part.added", { item_id: itemId, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
		ev("response.output_text.delta", { item_id: itemId, output_index: outputIndex, content_index: 0, delta: turn.text });
		const item = { id: itemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: turn.text, annotations: [] }] };
		ev("response.output_item.done", { output_index: outputIndex, item });
		outputItems.push(item);
		outputIndex++;
	}
	for (const tc of turn.toolCalls || []) {
		const itemId = `fc_${outputIndex}`;
		const callId = tc.id || `call_${outputIndex}`;
		const argStr = JSON.stringify(tc.args ?? {});
		ev("response.output_item.added", { output_index: outputIndex, item: { id: itemId, type: "function_call", status: "in_progress", call_id: callId, name: tc.name, arguments: "" } });
		ev("response.function_call_arguments.delta", { item_id: itemId, output_index: outputIndex, delta: argStr });
		const item = { id: itemId, type: "function_call", status: "completed", call_id: callId, name: tc.name, arguments: argStr };
		ev("response.output_item.done", { output_index: outputIndex, item });
		outputItems.push(item);
		outputIndex++;
	}
	ev("response.completed", {
		response: { id: respId, object: "response", status: "completed", model: modelId, output: outputItems, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
	});
	res.end();
}

// --- self-test ------------------------------------------------------------
async function selfTest() {
	const srv = await startFakeModelServer({ turns: [{ text: "FAKE-OK" }] });
	const checks = [];
	const probe = async (label, path, headers) => {
		const r = await fetch(`${srv.origin}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
		});
		const text = await r.text();
		const ok = text.includes("FAKE-OK");
		checks.push(ok);
		process.stdout.write(`[${ok ? "PASS" : "FAIL"}] ${label} streamed scripted text\n`);
	};
	try {
		await probe("openai-completions", "/v1/chat/completions", { authorization: "Bearer k" });
		await probe("anthropic-messages", "/v1/messages", { "x-api-key": "k" });
		await probe("openai-responses", "/v1/responses", { authorization: "Bearer k" });
	} finally {
		await srv.stop();
	}
	process.exit(checks.every(Boolean) ? 0 : 1);
}

if (isMain && process.argv[2] === "--self-test") {
	selfTest();
}
