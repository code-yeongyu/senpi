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
 * Turns are scripted protocol-independently ({ reasoning?, text?, toolCalls? });
 * each handler renders the matching SSE. Run `node fake-model-server.mjs --self-test`.
 */

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;

/**
 * @param {{ port?: number, turns?: Array<{reasoning?:string, text?:string, chunks?:number, chunkDelayMs?:number, toolCalls?:Array<{id?:string,name:string,args:object}>}> }} opts
 * @returns {Promise<{url:string, origin:string, port:number, requests:object[], streamLog:Array<{streamId:number,protocol:string,kind:string,delta:string}>, stop:()=>Promise<void>}>}
 *
 * A turn's non-empty `reasoning` and `text` fields are each emitted as ONE delta
 * by default. Set `chunks` (>1) to split either field into that many deltas and
 * `chunkDelayMs` to space those deltas apart. One shared emitter keeps text and
 * reasoning on the identical chunking/delay path for abort and steering QA.
 */
export function startFakeModelServer({ port = 0, turns = [{ text: "OK" }] } = {}) {
	const requests = [];
	const streamLog = [];
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
				raw,
				body,
				authorization: req.headers.authorization || null,
				apiKeyHeader: req.headers["x-api-key"] || null,
				model: body.model,
				stream: !!body.stream,
				messages: body.messages,
				// body.tools is the exact tool set the CLI put on the wire this turn.
				// Every provider senpi speaks (OpenAI chat/responses, Anthropic) carries
				// the active tool array here, so capturing it lets mock-loop QA prove
				// payload-level claims — inactive tools cost 0, cross-turn promotion —
				// against the REAL request bytes, not an in-process context.tools tap.
				tools: Array.isArray(body.tools) ? body.tools : null,
			});

			const url = req.url || "";
			if (req.method === "GET" && url.includes("/models")) {
				return sendJson(res, 200, { object: "list", data: [{ id: body.model || "mock", object: "model" }] });
			}

			const streamId = callIndex;
			const turn = turns[Math.min(callIndex, turns.length - 1)] || { text: "OK" };
			callIndex++;
			const modelId = body.model || "mock";

			if (url.includes("/chat/completions")) return writeCompletionsSse(res, turn, modelId, streamLog, streamId);
			if (url.includes("/messages")) return writeAnthropicSse(res, turn, modelId, streamLog, streamId);
			if (url.includes("/responses")) return writeResponsesSse(res, turn, modelId, streamLog, streamId);
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
				streamLog,
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

/** Split a string into `n` contiguous pieces that concatenate back to the original. */
function splitIntoChunks(text, n) {
	const chars = Array.from(text);
	if (chars.length === 0) return [""];
	const count = Math.max(1, Math.min(n, chars.length));
	const base = Math.floor(chars.length / count);
	let rem = chars.length % count;
	const pieces = [];
	let idx = 0;
	for (let i = 0; i < count; i++) {
		const take = base + (rem > 0 ? 1 : 0);
		if (rem > 0) rem--;
		pieces.push(chars.slice(idx, idx + take).join(""));
		idx += take;
	}
	return pieces;
}

/**
 * Emit either scripted string field through the shared chunk/delay machinery,
 * then run `done`. Without `chunks` each non-empty field is one synchronous
 * delta; with `chunks` > 1 it is split and spaced by `chunkDelayMs`.
 */
function emitDeltas(turn, value, emitDelta, done) {
	if (!value) return done();
	const n = Number.isInteger(turn.chunks) && turn.chunks > 1 ? turn.chunks : 0;
	if (!n) {
		emitDelta(value);
		return done();
	}
	const pieces = splitIntoChunks(value, n);
	const delay = Number.isFinite(turn.chunkDelayMs) ? turn.chunkDelayMs : 0;
	let i = 0;
	const tick = () => {
		emitDelta(pieces[i]);
		i++;
		if (i < pieces.length) setTimeout(tick, delay);
		else done();
	};
	tick();
}

function recordDelta(streamLog, streamId, protocol, kind, delta) {
	streamLog.push({ streamId, protocol, kind, delta });
}

// --- OpenAI chat completions ---------------------------------------------
function writeCompletionsSse(res, turn, modelId, streamLog, streamId) {
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
	const finish = () => {
		if (tcs.length) send({ tool_calls: tcs });
		send({}, tcs.length ? "tool_calls" : "stop");
		res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	};
	send({ role: "assistant", content: "" });
	emitDeltas(
		turn,
		turn.reasoning,
		(delta) => {
			send({ reasoning_content: delta });
			recordDelta(streamLog, streamId, "openai-completions", "reasoning_delta", delta);
		},
		() =>
			emitDeltas(
				turn,
				turn.text,
				(delta) => {
					send({ content: delta });
					recordDelta(streamLog, streamId, "openai-completions", "text_delta", delta);
				},
				finish,
			),
	);
}

// --- Anthropic Messages ---------------------------------------------------
function writeAnthropicSse(res, turn, modelId, streamLog, streamId) {
	sseHead(res);
	const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
	ev("message_start", {
		message: { id: "msg_mock", type: "message", role: "assistant", model: modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
	});
	let index = 0;
	const afterText = () => {
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
	};
	const emitText = () => {
		if (!turn.text) return afterText();
		ev("content_block_start", { index, content_block: { type: "text", text: "" } });
		emitDeltas(
			turn,
			turn.text,
			(delta) => {
				ev("content_block_delta", { index, delta: { type: "text_delta", text: delta } });
				recordDelta(streamLog, streamId, "anthropic-messages", "text_delta", delta);
			},
			() => {
				ev("content_block_stop", { index });
				index++;
				afterText();
			},
		);
	};
	if (!turn.reasoning) return emitText();
	ev("content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
	emitDeltas(
		turn,
		turn.reasoning,
		(delta) => {
			ev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: delta } });
			recordDelta(streamLog, streamId, "anthropic-messages", "reasoning_delta", delta);
		},
		() => {
			ev("content_block_stop", { index });
			index++;
			emitText();
		},
	);
}

// --- OpenAI Responses -----------------------------------------------------
function writeResponsesSse(res, turn, modelId, streamLog, streamId) {
	sseHead(res);
	let seq = 0;
	const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
	const respId = "resp_mock";
	ev("response.created", { response: { id: respId, object: "response", status: "in_progress", model: modelId, output: [] } });
	let outputIndex = 0;
	const outputItems = [];
	const afterText = () => {
		emitToolCalls();
		ev("response.completed", {
			response: { id: respId, object: "response", status: "completed", model: modelId, output: outputItems, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
		});
		res.end();
	};
	const emitText = () => {
		if (!turn.text) return afterText();
		const itemId = "msg_mock";
		ev("response.output_item.added", { output_index: outputIndex, item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] } });
		ev("response.content_part.added", { item_id: itemId, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
		emitDeltas(
			turn,
			turn.text,
			(delta) => {
				ev("response.output_text.delta", { item_id: itemId, output_index: outputIndex, content_index: 0, delta });
				recordDelta(streamLog, streamId, "openai-responses", "text_delta", delta);
			},
			() => {
				const item = { id: itemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: turn.text, annotations: [] }] };
				ev("response.output_item.done", { output_index: outputIndex, item });
				outputItems.push(item);
				outputIndex++;
				afterText();
			},
		);
	};
	const emitReasoning = () => {
		if (!turn.reasoning) return emitText();
		const itemId = "rsn_mock";
		ev("response.output_item.added", { output_index: outputIndex, item: { id: itemId, type: "reasoning", status: "in_progress", summary: [] } });
		emitDeltas(
			turn,
			turn.reasoning,
			(delta) => {
				ev("response.reasoning_summary_text.delta", { item_id: itemId, output_index: outputIndex, summary_index: 0, delta });
				recordDelta(streamLog, streamId, "openai-responses", "reasoning_delta", delta);
			},
			() => {
				const item = { id: itemId, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: turn.reasoning }] };
				ev("response.output_item.done", { output_index: outputIndex, item });
				outputItems.push(item);
				outputIndex++;
				emitText();
			},
		);
	};
	emitReasoning();

	function emitToolCalls() {
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
	}
}

function byteSequenceInOrder(bytes, parts) {
	let offset = 0;
	for (const part of parts) {
		const index = bytes.indexOf(Buffer.from(part), offset);
		if (index < 0) return false;
		offset = index + Buffer.byteLength(part);
	}
	return true;
}

// --- self-test ------------------------------------------------------------
async function selfTest() {
	const reasoning = "FAKE-THINK";
	const text = "FAKE-OK";
	const reasoningPieces = splitIntoChunks(reasoning, 2);
	const textPieces = splitIntoChunks(text, 2);
	const srv = await startFakeModelServer({ turns: [{ reasoning, text, chunks: 2, chunkDelayMs: 0 }] });
	const checks = [];
	const probe = async (label, path, headers, expectedBytes) => {
		const r = await fetch(`${srv.origin}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
		});
		const bytes = Buffer.from(await r.arrayBuffer());
		const scriptedText = textPieces.every((piece) => bytes.includes(Buffer.from(piece)));
		const exactReasoningSequence = byteSequenceInOrder(bytes, expectedBytes);
		checks.push(scriptedText, exactReasoningSequence);
		process.stdout.write(`[${scriptedText ? "PASS" : "FAIL"}] ${label} streamed scripted text\n`);
		process.stdout.write(`[${exactReasoningSequence ? "PASS" : "FAIL"}] ${label} reasoning SSE bytes are ordered and complete\n`);
	};
	try {
		await probe("openai-completions", "/v1/chat/completions", { authorization: "Bearer k" }, [
			`"reasoning_content":"${reasoningPieces[0]}"`,
			`"reasoning_content":"${reasoningPieces[1]}"`,
			`"content":"${textPieces[0]}"`,
			`"content":"${textPieces[1]}"`,
			"data: [DONE]\n\n",
		]);
		await probe("anthropic-messages", "/v1/messages", { "x-api-key": "k" }, [
			"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
			`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"${reasoningPieces[0]}"}}\n\n`,
			`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"${reasoningPieces[1]}"}}\n\n`,
			"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
			"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
			`event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"${textPieces[0]}"}}\n\n`,
		]);
		await probe("openai-responses", "/v1/responses", { authorization: "Bearer k" }, [
			"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"sequence_number\":1,\"output_index\":0,\"item\":{\"id\":\"rsn_mock\",\"type\":\"reasoning\",\"status\":\"in_progress\",\"summary\":[]}}\n\n",
			`event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","sequence_number":2,"item_id":"rsn_mock","output_index":0,"summary_index":0,"delta":"${reasoningPieces[0]}"}\n\n`,
			`event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","sequence_number":3,"item_id":"rsn_mock","output_index":0,"summary_index":0,"delta":"${reasoningPieces[1]}"}\n\n`,
			"event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"sequence_number\":4,\"output_index\":0,\"item\":{\"id\":\"rsn_mock\",\"type\":\"reasoning\",\"status\":\"completed\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"FAKE-THINK\"}]}}\n\n",
			"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"sequence_number\":5,\"output_index\":1,\"item\":{\"id\":\"msg_mock\",\"type\":\"message\"",
			"event: response.completed\n",
		]);
		const loggedReasoning = srv.streamLog.filter((entry) => entry.kind === "reasoning_delta").map((entry) => entry.delta);
		const logComplete = loggedReasoning.join("") === reasoning.repeat(3);
		checks.push(logComplete);
		process.stdout.write(`[${logComplete ? "PASS" : "FAIL"}] server stream log recorded all reasoning chunks\n`);
	} finally {
		await srv.stop();
	}
	process.exit(checks.every(Boolean) ? 0 : 1);
}

if (isMain && process.argv[2] === "--self-test") {
	selfTest();
}
