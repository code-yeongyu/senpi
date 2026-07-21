import { createServer, type Server, type ServerResponse } from "node:http";
import { findQaPort } from "./task23-fuzzy-client.ts";
import type { WireRecord } from "./task24-diff-client.ts";

export const TASK24_PROVIDER = "task24";
export const TASK24_MODEL = "task24-model";

export type Task24FakeModel = {
	readonly origin: string;
	readonly port: number;
	readonly responseCount: () => number;
	readonly stop: () => Promise<void>;
};

const zeroUsage = {
	input_tokens: 0,
	output_tokens: 0,
	total_tokens: 0,
	input_tokens_details: { cached_tokens: 0 },
	output_tokens_details: { reasoning_tokens: 0 },
};

export async function startTask24FakeModel(): Promise<Task24FakeModel> {
	const port = await findQaPort();
	let responseCount = 0;
	const server = createServer((request, response) => {
		if (request.method === "GET") {
			writeJson(response, { object: "list", data: [{ id: TASK24_MODEL }] });
			return;
		}
		if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
			writeJson(
				response,
				{ error: { message: `unexpected route ${request.method ?? ""} ${request.url ?? ""}` } },
				404,
			);
			return;
		}
		request.resume();
		request.once("end", () => {
			responseCount += 1;
			const events = responseEvents(responseCount);
			if (!events) {
				writeJson(response, { error: { message: `unexpected model request ${responseCount}` } }, 500);
				return;
			}
			writeSse(response, events);
		});
	});
	await listen(server, port);
	return {
		origin: `http://127.0.0.1:${port}/v1`,
		port,
		responseCount: () => responseCount,
		stop: () => closeServer(server),
	};
}

function responseEvents(index: number): readonly WireRecord[] | undefined {
	switch (index) {
		case 1:
			return toolResponse(index, "one.txt", "one old\n", "one new\n", true);
		case 2:
			return toolResponse(index, "two.txt", "two old\n", "two new\n", false);
		case 3:
			return textResponse(index, "Both edits completed.");
		case 4:
			return textResponse(index, "No files changed.");
		default:
			return undefined;
	}
}

function toolResponse(
	index: number,
	path: string,
	oldText: string,
	newText: string,
	includeWebSearch: boolean,
): readonly WireRecord[] {
	const responseId = `resp-task24-${index}`;
	const output: WireRecord[] = [];
	if (includeWebSearch) {
		output.push({
			type: "web_search_call",
			id: "ws-task24",
			status: "completed",
			action: { type: "search", query: "senpi parity", queries: null },
		});
	}
	output.push({
		type: "function_call",
		id: `fc-edit-${index}`,
		call_id: `call-edit-${index}`,
		name: "edit",
		arguments: JSON.stringify({ path, edits: [{ oldText, newText }] }),
		status: "completed",
	});
	return framedResponse(responseId, output);
}

function textResponse(index: number, text: string): readonly WireRecord[] {
	const responseId = `resp-task24-${index}`;
	const item = {
		type: "message",
		id: `msg-task24-${index}`,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text }],
	};
	return [
		{ type: "response.created", response: { id: responseId } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_item.done", output_index: 0, item },
		completed(responseId, [item]),
	];
}

function framedResponse(responseId: string, output: readonly WireRecord[]): readonly WireRecord[] {
	const events: WireRecord[] = [{ type: "response.created", response: { id: responseId } }];
	output.forEach((item, outputIndex) => {
		const addedItem =
			item.type === "web_search_call" ? { type: item.type, id: item.id, status: "in_progress" } : item;
		events.push({ type: "response.output_item.added", output_index: outputIndex, item: addedItem });
		events.push({ type: "response.output_item.done", output_index: outputIndex, item });
	});
	events.push(completed(responseId, output));
	return events;
}

function completed(responseId: string, output: readonly WireRecord[]): WireRecord {
	return { type: "response.completed", response: { id: responseId, status: "completed", output, usage: zeroUsage } };
}

function writeSse(response: ServerResponse, events: readonly WireRecord[]): void {
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
	response.end("data: [DONE]\n\n");
}

function writeJson(response: ServerResponse, value: WireRecord, status = 200): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}

function listen(server: Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function closeServer(server: Server): Promise<void> {
	server.closeAllConnections();
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}
