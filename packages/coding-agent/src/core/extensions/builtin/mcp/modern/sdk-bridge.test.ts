import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	ElicitRequestSchema,
	type JSONRPCMessage,
	ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { ModernSdkBridge } from "./sdk-bridge.ts";
import { ModernHttpTransport } from "./transport.ts";
import { MODERN_PROTOCOL_VERSION } from "./wire.ts";

const discovery = {
	resultType: "complete" as const,
	supportedVersions: [MODERN_PROTOCOL_VERSION],
	capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
	_meta: { "io.modelcontextprotocol/serverInfo": { name: "modern-only", version: "1", title: "Modern" } },
	instructions: "Use these tools",
};

describe("modern SDK lifecycle bridge", () => {
	it("populates SDK state through local initialize while keeping all wire traffic modern", async () => {
		const sent: { method: string; body: string; headers: Headers }[] = [];
		const streamClosed = Promise.withResolvers<void>();
		const cancelStream = vi.fn(() => streamClosed.resolve());
		const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
			sent.push({ method: String(init?.method), body: String(init?.body), headers: new Headers(init?.headers) });
			const message = JSON.parse(String(init?.body));
			if (message.method === "subscriptions/listen") {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								`data: ${JSON.stringify({
									jsonrpc: "2.0",
									method: "notifications/subscriptions/acknowledged",
									params: {
										_meta: { "io.modelcontextprotocol/subscriptionId": message.id },
										notifications: { toolsListChanged: true },
									},
								})}\n\n`,
							),
						);
					},
					cancel: cancelStream,
				});
				return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
			}
			const result =
				message.method === "tools/list"
					? {
							resultType: "complete",
							tools: [{ name: "echo", inputSchema: { type: "object" } }],
							nextCursor: null,
						}
					: { resultType: "complete", content: [{ type: "text", text: "ok" }] };
			return Response.json({ jsonrpc: "2.0", id: message.id, result });
		});
		const transport = new ModernHttpTransport({
			url: "https://fixture.test/mcp",
			fetch,
			clientInfo: { name: "test", version: "1" },
			clientCapabilities: { elicitation: {} },
		});
		const bridge = new ModernSdkBridge(transport, discovery, MODERN_PROTOCOL_VERSION);
		const client = new Client({ name: "test", version: "1" }, { capabilities: { elicitation: {} } });
		try {
			await client.connect(bridge);
			expect(sent).toEqual([]);
			expect(client.getServerCapabilities()).toEqual(discovery.capabilities);
			expect(client.getServerVersion()).toEqual(discovery._meta["io.modelcontextprotocol/serverInfo"]);
			expect(client.getInstructions()).toBe(discovery.instructions);
			expect((await client.listTools()).tools[0]?.name).toBe("echo");
			expect(await client.callTool({ name: "echo" })).toMatchObject({ content: [{ text: "ok" }] });
			expect(cancelStream).not.toHaveBeenCalled();
		} finally {
			await client.close();
		}
		// #4193: advertised list changes require a listen stream, but neither SDK call waits for its end.
		await streamClosed.promise;
		expect(cancelStream).toHaveBeenCalledOnce();
		expect(sent.map(({ body }) => JSON.parse(body).method)).toEqual([
			"subscriptions/listen",
			"tools/list",
			"tools/call",
		]);
		expect(JSON.parse(sent[0]?.body ?? "{}").params.notifications).toEqual({ toolsListChanged: true });
		for (const request of sent) {
			expect(request.method).toBe("POST");
			expect(request.headers.get("MCP-Protocol-Version")).toBe(MODERN_PROTOCOL_VERSION);
			expect(JSON.parse(request.body).params._meta["io.modelcontextprotocol/protocolVersion"]).toBe(
				MODERN_PROTOCOL_VERSION,
			);
			expect(request.headers.has("Mcp-Session-Id")).toBe(false);
		}
	});

	it("keeps SDK notification and elicitation handlers on the same client", async () => {
		const replies: JSONRPCMessage[] = [];
		const received = Promise.withResolvers<void>();
		const streamEnded = Promise.withResolvers<void>();
		let subscriptionId: string | number | undefined;
		const inner: Transport = {
			start: async () => {},
			close: async () => {
				streamEnded.resolve();
				inner.onclose?.();
			},
			send: async (message) => {
				if ("method" in message) {
					if (message.method === "subscriptions/listen" && "id" in message) {
						subscriptionId = message.id;
						inner.onmessage?.({
							jsonrpc: "2.0",
							method: "notifications/subscriptions/acknowledged",
							params: {
								_meta: { "io.modelcontextprotocol/subscriptionId": message.id },
								notifications: { toolsListChanged: true },
							},
						});
						await streamEnded.promise;
					} else if (message.method === "tools/list" && "id" in message) {
						inner.onmessage?.({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
					}
					return;
				}
				replies.push(message);
				received.resolve();
			},
		};
		const client = new Client({ name: "test", version: "1" }, { capabilities: { elicitation: {} } });
		const notified = Promise.withResolvers<void>();
		client.setNotificationHandler(ToolListChangedNotificationSchema, () => notified.resolve());
		client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { answer: "yes" } }));
		try {
			await client.connect(new ModernSdkBridge(inner, discovery, MODERN_PROTOCOL_VERSION));
			await client.listTools();
			expect(subscriptionId).toBeDefined();
			// #4193: deliver a notification only after its subscription is acknowledged.
			inner.onmessage?.({
				jsonrpc: "2.0",
				method: "notifications/tools/list_changed",
				params: { _meta: { "io.modelcontextprotocol/subscriptionId": subscriptionId } },
			});
			await notified.promise;
			inner.onmessage?.({
				jsonrpc: "2.0",
				id: "server-request",
				method: "elicitation/create",
				params: {
					message: "Choose",
					requestedSchema: { type: "object", properties: { answer: { type: "string" } } },
				},
			});
			await received.promise;
			expect(replies).toEqual([
				{ jsonrpc: "2.0", id: "server-request", result: { action: "accept", content: { answer: "yes" } } },
			]);
		} finally {
			await client.close();
		}
		await streamEnded.promise;
	});

	it("refuses unsupported discovery versions and malformed SDK capabilities", () => {
		const inner: Transport = { start: async () => {}, close: async () => {}, send: async () => {} };
		expect(
			() => new ModernSdkBridge(inner, { ...discovery, supportedVersions: ["future"] }, MODERN_PROTOCOL_VERSION),
		).toThrow(/does not support/);
		expect(
			() =>
				new ModernSdkBridge(inner, { ...discovery, capabilities: { tools: "invalid" } }, MODERN_PROTOCOL_VERSION),
		).toThrow();
	});
});
