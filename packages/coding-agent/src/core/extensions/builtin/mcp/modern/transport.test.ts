import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { ModernHttpTransport } from "./transport.ts";

const clientInfo = { name: "senpi", version: "test" };
const clientCapabilities = { elicitation: { form: {} } };
const result = { jsonrpc: "2.0", id: 1, result: { resultType: "complete", tools: [] } } as const;
const url = "https://example.test/mcp";

function transport(fetch: FetchLike, options: { protocolVersion?: string; headers?: RequestInit["headers"] } = {}) {
	return new ModernHttpTransport({ url, fetch, clientInfo, clientCapabilities, ...options });
}

// senpi#3304: assert the stateless protocol at the fetch boundary, not the wire helper.
describe("modern HTTP MCP transport", () => {
	it.each([undefined, "2026-08-01"])("sends matching metadata and headers for version %s", async (protocolVersion) => {
		const fetch = vi.fn<FetchLike>().mockResolvedValue(Response.json(result));
		const client: Transport = transport(fetch, {
			protocolVersion,
			headers: { Authorization: "Bearer fixture", "mcp-protocol-version": "wrong", "Mcp-Session-Id": "forbidden" },
		});
		const received = vi.fn();
		client.onmessage = received;
		await client.start();

		await client.send({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
			params: { cursor: "next", _meta: { progressToken: 7, "io.modelcontextprotocol/protocolVersion": "wrong" } },
		});
		await client.close();

		expect(fetch).toHaveBeenCalledTimes(1);
		const [target, init] = fetch.mock.calls[0];
		expect(target.toString()).toBe(url);
		expect(init?.method).toBe("POST");
		const body = JSON.parse(String(init?.body));
		expect(body.params).toEqual({
			cursor: "next",
			_meta: {
				progressToken: 7,
				"io.modelcontextprotocol/protocolVersion": protocolVersion ?? "2026-07-28",
				"io.modelcontextprotocol/clientInfo": clientInfo,
				"io.modelcontextprotocol/clientCapabilities": clientCapabilities,
			},
		});
		const headers = new Headers(init?.headers);
		expect(headers.get("MCP-Protocol-Version")).toBe(body.params._meta["io.modelcontextprotocol/protocolVersion"]);
		expect(headers.get("Mcp-Method")).toBe("tools/list");
		expect(headers.get("Mcp-Session-Id")).toBeNull();
		expect(headers.get("Authorization")).toBe("Bearer fixture");
		expect(headers.get("Content-Type")).toBe("application/json");
		expect(headers.get("Accept")).toContain("text/event-stream");
		expect(received).toHaveBeenCalledWith(result);
	});

	it.each([
		["tools/call", { name: "echo" }, "echo"],
		["prompts/get", { name: "\uD55C\uAE00" }, "base64:7ZWc6riA"],
		["resources/read", { uri: "x:\u00FF", name: "ignored" }, "base64:eDrDvw"],
		["tools/call", { name: "base64:literal" }, "base64:YmFzZTY0OmxpdGVyYWw"],
		["tools/list", { name: "ignored" }, null],
	])("routes %s with the canonical name encoding", async (method, params, expected) => {
		const fetch = vi.fn<FetchLike>().mockResolvedValue(Response.json(result));
		const client = transport(fetch, { headers: { "Mcp-Name": "wrong", "Mcp-Method": "wrong" } });
		await client.start();

		await client.send({ jsonrpc: "2.0", id: 1, method, params });

		const headers = new Headers(fetch.mock.calls[0][1]?.headers);
		expect(headers.get("Mcp-Name")).toBe(expected);
		expect(headers.get("Mcp-Method")).toBe(method);
		await client.close();
	});

	it("POSTs notifications and responses individually without session traffic", async () => {
		const fetch = vi.fn<FetchLike>().mockImplementation(async () => new Response(null, { status: 202 }));
		const client = transport(fetch);
		await client.start();

		await client.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
		await client.send({ jsonrpc: "2.0", id: "server-request", result: {} });
		await client.close();

		expect(fetch).toHaveBeenCalledTimes(2);
		const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
		expect(bodies[0]).not.toHaveProperty("id");
		expect(bodies[0].params._meta["io.modelcontextprotocol/clientInfo"]).toEqual(clientInfo);
		expect(bodies[1]).toEqual({ jsonrpc: "2.0", id: "server-request", result: {} });
		for (const [, init] of fetch.mock.calls) {
			expect(init?.method).toBe("POST");
			expect(new Headers(init?.headers).has("Mcp-Session-Id")).toBe(false);
		}
	});

	it("consumes chunked SSE with multiline data and delivers the final response", async () => {
		const notification = { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } };
		const bytes = new TextEncoder().encode(
			`: keepalive\r\nevent: message\r\ndata: ${JSON.stringify(notification)}\r\n\r\n` +
				`event: message\r\ndata: {"jsonrpc":"2.0","id":1,\r\ndata: "result":{"resultType":"complete","text":"\uD55C\uAE00"}}\r\n\r\n`,
		);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
				controller.close();
			},
		});
		const fetch = vi
			.fn<FetchLike>()
			.mockResolvedValue(new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } }));
		const client = transport(fetch);
		const messages: JSONRPCMessage[] = [];
		client.onmessage = (message) => messages.push(message);
		await client.start();

		await client.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } });

		expect(messages).toEqual([
			notification,
			{ jsonrpc: "2.0", id: 1, result: { resultType: "complete", text: "\uD55C\uAE00" } },
		]);
		await client.close();
	});

	it("finishes an SSE request when its final response arrives before stream EOF", async () => {
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(result)}\n\n`));
			},
			cancel,
		});
		const client = transport(async () => new Response(stream, { headers: { "Content-Type": "text/event-stream" } }));
		client.onmessage = vi.fn();
		await client.start();

		await client.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });

		expect(client.onmessage).toHaveBeenCalledWith(result);
		expect(cancel).toHaveBeenCalledTimes(1);
		await client.close();
	}, 1000);

	it.each([
		() => new Response("unavailable", { status: 503 }),
		() => Response.json({ invalid: true }),
		() => new Response("data: invalid\n\n", { headers: { "Content-Type": "text/event-stream" } }),
		() =>
			new Response('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n', {
				headers: { "Content-Type": "text/event-stream" },
			}),
	])("reports HTTP and malformed response failures through onerror and send", async (response) => {
		const client = transport(async () => response());
		const onerror = vi.fn();
		client.onerror = onerror;
		await client.start();

		await expect(client.send({ jsonrpc: "2.0", id: 1, method: "tools/list" })).rejects.toBeInstanceOf(Error);

		expect(onerror).toHaveBeenCalledTimes(1);
		await client.close();
	});

	it("delivers JSON-RPC errors as messages rather than transport errors", async () => {
		const error = { jsonrpc: "2.0", id: 1, error: { code: -32022, message: "unsupported", data: { supported: [] } } };
		const client = transport(async () => Response.json(error, { status: 400 }));
		client.onmessage = vi.fn();
		client.onerror = vi.fn();
		await client.start();

		await client.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });

		expect(client.onmessage).toHaveBeenCalledWith(error);
		expect(client.onerror).not.toHaveBeenCalled();
		await client.close();
	});

	it("aborts active POSTs on close and invokes onclose only once", async () => {
		const entered = Promise.withResolvers<AbortSignal>();
		const fetch: FetchLike = async (_url, init) => {
			const signal = init?.signal;
			if (!signal) throw new Error("missing signal");
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				entered.resolve(signal);
			});
		};
		const client = transport(fetch);
		client.onclose = vi.fn();
		await client.start();
		const pending = client.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		const rejected = expect(pending).rejects.toBeInstanceOf(Error);
		const signal = await entered.promise;

		await client.close();
		await client.close();

		await rejected;
		expect(signal.aborted).toBe(true);
		expect(client.onclose).toHaveBeenCalledTimes(1);
		await expect(client.send({ jsonrpc: "2.0", id: 2, method: "ping" })).rejects.toThrow();
	});

	it("cancels an active SSE reader on close", async () => {
		const reading = Promise.withResolvers<void>();
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'),
				);
			},
			cancel,
		});
		const client = transport(async () => new Response(stream, { headers: { "Content-Type": "text/event-stream" } }));
		client.onmessage = () => reading.resolve();
		await client.start();
		const pending = client.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		const rejected = expect(pending).rejects.toBeInstanceOf(Error);
		await reading.promise;

		await client.close();

		await rejected;
		expect(cancel).toHaveBeenCalledTimes(1);
	}, 1000);
});
