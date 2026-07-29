import { createServer } from "node:http";
import { trackCloser, untrackCloser } from "./cleanup.mjs";

export async function startFakeModelServer(turns) {
	const requests = [];
	const holds = [];
	const requestWaiters = new Set();
	const holdWaiters = new Set();
	const responses = new Set();
	const heldResponses = new Set();
	let callIndex = 0;
	const server = createServer((req, res) => {
		responses.add(res);
		res.once("close", () => responses.delete(res));
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const body = parseJson(Buffer.concat(chunks).toString("utf8"));
			const requestRecord = {
				method: req.method,
				url: req.url,
				authorization: req.headers.authorization ?? null,
				model: body.model,
				messages: body.messages,
			};
			const requestIndex = requests.push(requestRecord) - 1;
			notifyRecordWaiters(requestWaiters, requestRecord, requestIndex);
			if (req.method === "GET" && (req.url ?? "").includes("/models")) {
				sendJson(res, 200, { object: "list", data: [{ id: "mock-model", object: "model" }] });
				return;
			}
			if (!(req.url ?? "").includes("/chat/completions")) {
				sendJson(res, 404, { error: { message: `no route ${req.method ?? ""} ${req.url ?? ""}` } });
				return;
			}
			const turn = turns[Math.min(callIndex, turns.length - 1)] ?? { text: "OK" };
			callIndex += 1;
			if (turn.error) {
				sendJson(res, turn.error.status, { error: { message: turn.error.message } });
				return;
			}
			writeCompletionsSse(res, turn, body.model ?? "mock-model", heldResponses, () => {
				const holdRecord = { request: requestRecord, requestIndex };
				const holdIndex = holds.push(holdRecord) - 1;
				notifyRecordWaiters(holdWaiters, holdRecord, holdIndex);
			});
		});
	});
	const port = await listenOnEphemeralPort(server);
	const close = () => server.close();
	trackCloser(close);
	return {
		url: `http://127.0.0.1:${port}/v1`,
		requests,
		holds,
		waitForRequest: (predicate, fromIndex = 0, timeoutMs = 20_000) =>
			waitForRecord(requests, requestWaiters, predicate, fromIndex, timeoutMs, "request"),
		waitForHold: (predicate, fromIndex = 0, timeoutMs = 20_000) =>
			waitForRecord(holds, holdWaiters, predicate, fromIndex, timeoutMs, "hold"),
		releaseHolds: () => {
			for (const release of [...heldResponses]) release();
		},
		stop: () =>
			new Promise((resolveStop) => {
				untrackCloser(close);
				rejectWaiters(requestWaiters, "request");
				rejectWaiters(holdWaiters, "hold");
				for (const response of responses) response.destroy();
				server.close(() => resolveStop());
			}),
	};
}

function waitForRecord(records, waiters, predicate, fromIndex, timeoutMs, label) {
	const existing = records.slice(fromIndex).find(predicate);
	if (existing !== undefined) return Promise.resolve(existing);
	return new Promise((resolveWait, rejectWait) => {
		const waiter = { predicate, fromIndex, resolveWait, rejectWait, timeout: undefined };
		waiter.timeout = setTimeout(() => {
			waiters.delete(waiter);
			rejectWait(
				new Error(`Timed out waiting for fake model ${label} (${records.length} ${label} record(s) observed)`),
			);
		}, timeoutMs);
		waiters.add(waiter);
	});
}

function notifyRecordWaiters(waiters, record, index) {
	for (const waiter of [...waiters]) {
		if (index < waiter.fromIndex || !waiter.predicate(record)) continue;
		clearTimeout(waiter.timeout);
		waiters.delete(waiter);
		waiter.resolveWait(record);
	}
}

function rejectWaiters(waiters, label) {
	for (const waiter of waiters) {
		clearTimeout(waiter.timeout);
		waiter.rejectWait(new Error(`Fake model stopped while waiting for ${label}`));
	}
	waiters.clear();
}

function listenOnEphemeralPort(server) {
	return new Promise((resolve, reject) => {
		const onError = (error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close(() => reject(new Error("Fake model server did not expose a TCP port")));
				return;
			}
			resolve(address.port);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(0, "127.0.0.1");
	});
}

function parseJson(raw) {
	try {
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}

function sendJson(res, status, obj) {
	res.writeHead(status, { "content-type": "application/json", connection: "close" });
	res.end(JSON.stringify(obj));
}

function writeCompletionsSse(res, turn, modelId, heldResponses, onHold) {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "close",
	});
	const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model: modelId };
	const send = (delta, finish = null) => {
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
	};
	const complete = () => {
		res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	};
	send({ role: "assistant", content: "" });
	if (turn.hold === true) {
		let release;
		release = () => {
			heldResponses.delete(release);
			if (res.destroyed) return;
			send({}, turn.finishReason ?? "stop");
			complete();
		};
		heldResponses.add(release);
		res.once("close", () => heldResponses.delete(release));
		onHold();
		return;
	}
	if (turn.toolCalls?.length) {
		send({
			tool_calls: turn.toolCalls.map((toolCall, index) => ({
				index,
				id: toolCall.id ?? `call_${index + 1}`,
				type: "function",
				function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args ?? {}) },
			})),
		});
		send({}, "tool_calls");
		complete();
		return;
	}
	streamTextChunks(res, send, complete, turn);
}

function streamTextChunks(res, send, complete, turn) {
	const chunks = turn.chunks ?? [turn.text ?? "OK"];
	const delayMs = turn.delayMs ?? 0;
	let index = 0;
	const timer = setInterval(() => {
		if (res.destroyed) {
			clearInterval(timer);
			return;
		}
		if (index < chunks.length) {
			send({ content: chunks[index] });
			index += 1;
			return;
		}
		clearInterval(timer);
		send({}, turn.finishReason ?? "stop");
		complete();
	}, Math.max(1, delayMs));
}
