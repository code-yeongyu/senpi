import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import { probeStdioTransport } from "../../src/core/extensions/builtin/mcp/modern/stdio-probe.ts";
import { ModernHttpTransport } from "../../src/core/extensions/builtin/mcp/modern/transport.ts";
import { MrtrScript } from "./fixtures/mrtr-2026-server.ts";
import { makeRoot } from "./fixtures/service-lifecycle.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});
const request = (id: number) => ({
	jsonrpc: "2.0" as const,
	id,
	method: "tools/call",
	params: { name: "fixture" },
});
const cancel = (id: number) => ({
	jsonrpc: "2.0" as const,
	method: "notifications/cancelled",
	params: { requestId: id },
});

describe("MRTR transport correlation", () => {
	it("an HTTP reply cannot settle a different in-flight request identifier", async () => {
		const replies = new Map([
			[1, Promise.withResolvers<Response>()],
			[2, Promise.withResolvers<Response>()],
		]);
		const transport = new ModernHttpTransport({
			url: "http://fixture.invalid/mcp",
			clientInfo: { name: "test", version: "1" },
			clientCapabilities: {},
			fetch: async (_url, init) => {
				const message = JSONRPCMessageSchema.parse(JSON.parse(String(init?.body)));
				const reply = "id" in message ? replies.get(Number(message.id)) : undefined;
				if (!reply) throw new Error("Unexpected request");
				return await reply.promise;
			},
		});
		cleanup.push(() => transport.close());
		const delivered: JSONRPCMessage[] = [];
		transport.onmessage = (message) => delivered.push(message);
		await transport.start();
		const first = transport.send(request(1)).then(
			() => undefined,
			(error: unknown) => error,
		);
		const second = transport.send(request(2));
		replies.get(1)?.resolve(Response.json({ jsonrpc: "2.0", id: 2, result: { content: [] } }));
		const failure = await first;
		replies
			.get(2)
			?.resolve(Response.json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "real" }] } }));
		await second;
		expect(failure).toMatchObject({ code: "MCP_MRTR_INVALID_RESULT" });
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toHaveProperty(["result", "content", 0, "text"], "real");
	});

	it("stdio cancels only the live round once and drops completed or cancelled replies and progress", async () => {
		const root = makeRoot("mrtr-stdio-correlation", cleanup);
		const script = new MrtrScript();
		const sent: JSONRPCMessage[] = [];
		const delivered: JSONRPCMessage[] = [];
		const transport: Transport = {
			async start() {},
			async close() {
				transport.onclose?.();
			},
			async send(message) {
				sent.push(message);
				if ("method" in message && message.method === "server/discover" && "id" in message) {
					transport.onmessage?.(
						JSONRPCMessageSchema.parse(
							script.reply({
								jsonrpc: "2.0",
								id: message.id,
								method: message.method,
								params: message.params,
							}),
						),
					);
				}
			},
		};
		cleanup.push(() => transport.close());
		transport.onmessage = (message) => delivered.push(message);
		probeStdioTransport(
			transport,
			{
				clientInfo: { name: "test", version: "1" },
				clientCapabilities: {},
				supportedVersions: ["2026-07-28"],
			},
			createMcpLogger("fixture", { logDir: root.agentDir }),
			10000,
			"fixture",
		);
		await transport.start();
		const reply = (id: number) => transport.onmessage?.({ jsonrpc: "2.0", id, result: { content: [] } });
		const progress = (id: number) =>
			transport.onmessage?.({
				jsonrpc: "2.0",
				method: "notifications/progress",
				params: { progressToken: id, progress: 1 },
			});
		await transport.send(request(1));
		reply(1);
		await transport.send(cancel(1));
		await transport.send(request(2));
		progress(1);
		progress(2);
		await transport.send(cancel(2));
		await transport.send(cancel(2));
		reply(1);
		reply(2);
		progress(2);
		expect(sent.filter((message) => "method" in message && message.method === "notifications/cancelled")).toEqual([
			expect.objectContaining({ params: { requestId: 2, reason: "MCP request canceled" } }),
		]);
		expect(delivered).toEqual([
			expect.objectContaining({ id: 1 }),
			expect.objectContaining({ method: "notifications/progress", params: { progressToken: 2, progress: 1 } }),
		]);
	});
});
