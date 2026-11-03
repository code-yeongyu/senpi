import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { installModernRequestAdapter } from "../../src/core/extensions/builtin/mcp/modern/request.ts";
import { ModernSdkBridge } from "../../src/core/extensions/builtin/mcp/modern/sdk-bridge.ts";
import { ModernHttpTransport } from "../../src/core/extensions/builtin/mcp/modern/transport.ts";
import { callMcpTool } from "../../src/core/extensions/builtin/mcp/expose/call.ts";
import type { McpToolCatalogEntry } from "../../src/core/extensions/builtin/mcp/catalog.ts";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";

describe("modern tasks HTTP routing", () => {
	it.each(["complete", "abort"] as const)("routes task %s and displays status through the tool row", async (mode) => {
		const id = "synthetic-task";
		const seen: Array<{ method: string; params: Record<string, unknown>; headers: Headers }> = [];
		const updates: string[] = [];
		const caller = new AbortController();
		const task = {
			taskId: id,
			status: "working",
			statusMessage: "processing batch",
			createdAt: "2026-07-28T00:00:00Z",
			lastUpdatedAt: "2026-07-28T00:00:00Z",
			ttlMs: null,
			pollIntervalMs: 0,
		};
		const client = new Client({ name: "fixture", version: "1" });
		installModernRequestAdapter(client, { version: "2026-07-28" });
		const transport = new ModernSdkBridge(
			new ModernHttpTransport({
				url: "https://synthetic.invalid/mcp",
				clientInfo: { name: "fixture", version: "1" },
				clientCapabilities: {},
				fetch: async (_url, init) => {
					const request = JSON.parse(String(init?.body)) as {
						id: number;
						method: string;
						params: Record<string, unknown>;
					};
					seen.push({ ...request, headers: new Headers(init?.headers) });
					const result =
						request.method === "tools/call"
							? { ...task, resultType: "task" }
							: request.method === "tasks/get"
								? { ...task, status: "completed", result: { content: [{ type: "text", text: "done" }] } }
								: {};
					return Response.json({ jsonrpc: "2.0", id: request.id, result });
				},
			}),
			{
				resultType: "complete",
				supportedVersions: ["2026-07-28"],
				capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/tasks": {} } },
				_meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture", version: "1" } },
			},
			"2026-07-28",
		);
		await client.connect(transport);
		const connection = Object.create(ServerConnection.prototype) as ServerConnection;
		Object.defineProperties(connection, {
			client: { value: client },
			state: { value: "connected" },
		});
		const entry: McpToolCatalogEntry = {
			server: "fixture",
			tool: "test",
			schema: { type: "object" },
			connection,
			requestTimeoutMs: 1000,
			// The preflight is outside this test's request contract.
			invocation: {
				identity: () => ({ owner: entry, operation: "fixture", metadata: "fixture" }),
				resolve: async () => ({ kind: "ready", entry, isCurrent: () => true }),
			},
		};
		try {
			const pending = callMcpTool(
				entry,
				{},
				caller.signal,
				(update: AgentToolResult<unknown>) => {
					for (const content of update.content) if (content.type === "text") updates.push(content.text);
					if (mode === "abort") caller.abort();
				},
				"fixture",
				undefined,
			);
			if (mode === "complete") {
				expect(await pending).toMatchObject({
					kind: "called",
					result: { content: [{ type: "text", text: "done" }] },
				});
			} else {
				await expect(pending).rejects.toMatchObject({ code: "MCP_MRTR_CANCELLED" });
			}
			expect(updates).toEqual([expect.stringContaining(`MCP task ${id}: working - processing batch`)]);
			const followup = seen[1];
			expect(followup?.method).toBe(mode === "complete" ? "tasks/get" : "tasks/cancel");
			expect(followup?.headers.get("Mcp-Name")).toBe(id);
			expect(followup?.headers.get("Mcp-Method")).toBe(followup?.method);
			expect(followup?.params).toHaveProperty(
				["_meta", "io.modelcontextprotocol/clientCapabilities", "extensions", "io.modelcontextprotocol/tasks"],
				{},
			);
		} finally {
			await client.close();
		}
	});
});
