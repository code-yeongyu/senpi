/**
 * A local OpenAI-compatible chat-completions mock for the offload harness and the QA driver. Each
 * request is answered by `respond(body)` with one step: `{ tool, args }` (one tool call), `{ text }`
 * (a final answer) or `{ hold: true }` (the response is never sent: the turn cannot settle, which is
 * how `--mutate force-timeout` forces a turn timeout). No real provider is ever reachable.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const chunk = (model, delta, finish = null) =>
	`data: ${JSON.stringify({ id: "qa", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

function sse(step, model) {
	if ("tool" in step) {
		const call = { index: 0, id: `call_${randomUUID().slice(0, 8)}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } };
		return [chunk(model, { role: "assistant", tool_calls: [call] }), chunk(model, {}, "tool_calls")].join("");
	}
	return [chunk(model, { role: "assistant", content: step.text }), chunk(model, {}, "stop")].join("");
}

export function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

export async function startMockModel(respond) {
	const held = new Set();
	let requests = 0;
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (data) => chunks.push(data));
		req.on("end", () => {
			const url = req.url ?? "";
			if (url.endsWith("/models")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [] }));
				return;
			}
			if (!url.endsWith("/chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			requests += 1;
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
			const step = respond(body);
			if (step.hold) {
				held.add(res);
				res.once("close", () => held.delete(res));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(`${sse(step, body.model ?? "qa")}data: [DONE]\n\n`);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requestCount: () => requests,
		async stop() {
			for (const res of held) res.destroy();
			server.closeAllConnections?.();
			await new Promise((resolve) => server.close(() => resolve()));
		},
	};
}
