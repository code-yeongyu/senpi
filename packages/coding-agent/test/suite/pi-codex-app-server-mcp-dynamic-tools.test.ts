import { describe, expect, it } from "vitest";
import { createIdMapper } from "../../src/core/extensions/builtin/pi-codex-app-server/id-mapper.ts";
import { createNotificationProjector } from "../../src/core/extensions/builtin/pi-codex-app-server/notification-projector.ts";
import {
	type AppServerCallbackClient,
	createServerRequestBridge,
} from "../../src/core/extensions/builtin/pi-codex-app-server/server-request-bridge.ts";
import { createSessionRegistry } from "../../src/core/extensions/builtin/pi-codex-app-server/session-registry.ts";

class RecordingCallbackClient implements AppServerCallbackClient {
	readonly responses: { readonly appRequestId: string; readonly response: unknown }[] = [];
	readonly rejections: { readonly appRequestId: string; readonly reason: string }[] = [];

	async respond(appRequestId: string, response: unknown): Promise<void> {
		this.responses.push({ appRequestId, response });
	}

	async reject(appRequestId: string, reason: string): Promise<void> {
		this.rejections.push({ appRequestId, reason });
	}
}

function createMcpDynamicFixture() {
	const idMapper = createIdMapper(() => 1000);
	const sessionRegistry = createSessionRegistry();
	const bindResult = sessionRegistry.bindSession({
		externalSessionId: "external-session-1",
		appThreadId: "app-thread-1",
		appSessionId: "app-session-1",
	});
	expect(bindResult.kind).toBe("bound");
	const callbackClient = new RecordingCallbackClient();
	const bridge = createServerRequestBridge({
		connectionId: "connection-1",
		capabilityFlags: ["opaque-callbacks", "dynamic-tools", "mcp-elicitation"],
		callbackTimeoutMs: 5000,
		nowMs: () => 1000,
		idMapper,
		sessionRegistry,
		callbackClient,
	});
	const projector = createNotificationProjector({
		connectionId: "connection-1",
		capabilityFlags: ["semantic-events", "opaque-notifications"],
		notificationOptOuts: [],
		idMapper,
		sessionRegistry,
	});
	return { bridge, callbackClient, idMapper, projector };
}

describe("pi-codex-app-server MCP and dynamic tool compatibility", () => {
	it("delivers dynamic tool callbacks with structured content and metadata intact", async () => {
		const { bridge, callbackClient, idMapper } = createMcpDynamicFixture();
		const params = {
			threadId: "app-thread-1",
			turnId: "app-turn-1",
			itemId: "app-dynamic-tool-1",
			toolCallId: "tool-call-1",
			toolName: "lookup_customer",
			input: { customerId: "cust-123" },
			structuredContent: { customerId: "cust-123", status: "active" },
			_meta: { traceId: "trace-dynamic-1", widgetAccessible: true },
		};

		const delivered = bridge.deliver({
			method: "item/tool/call",
			requestId: "app-request-dynamic-1",
			params,
		});

		expect(delivered).toMatchObject({
			kind: "delivered",
			request: {
				method: "appServer/request",
				externalCallbackId: "callback-app-request-dynamic-1",
				envelope: {
					externalSessionId: "external-session-1",
					appThreadId: "app-thread-1",
					appSessionId: "app-session-1",
					appTurnId: "app-turn-1",
					appItemId: "app-dynamic-tool-1",
					appRequestId: "app-request-dynamic-1",
					originalMethod: "item/tool/call",
					originalParams: params,
					redactionClass: "public-contract",
				},
			},
		});
		expect(idMapper.getServerRequest("app-request-dynamic-1")).toMatchObject({
			appRequestId: "app-request-dynamic-1",
			externalCallbackId: "callback-app-request-dynamic-1",
			method: "item/tool/call",
		});

		const responsePayload = {
			content: [{ type: "text", text: "customer is active" }],
			structuredContent: { customerId: "cust-123", status: "active" },
			_meta: { traceId: "trace-dynamic-1", renderedBy: "external-tool" },
		};
		const response = await bridge.respond({
			externalCallbackId: "callback-app-request-dynamic-1",
			response: responsePayload,
		});

		expect(response).toEqual({ kind: "forwarded" });
		expect(callbackClient.responses).toEqual([{ appRequestId: "app-request-dynamic-1", response: responsePayload }]);
		expect(callbackClient.rejections).toEqual([]);
	});

	it("delivers MCP elicitation callbacks without flattening form metadata", async () => {
		const { bridge, callbackClient } = createMcpDynamicFixture();
		const params = {
			threadId: "app-thread-1",
			turnId: "app-turn-1",
			itemId: "app-mcp-elicitation-1",
			serverName: "crm",
			toolName: "enrich_contact",
			message: "Choose enrichment fields",
			requestedSchema: {
				type: "object",
				properties: {
					includeEmail: { type: "boolean", title: "Email" },
				},
			},
			_meta: {
				"openai/form": { title: "CRM enrichment", submitLabel: "Continue" },
				traceId: "trace-mcp-1",
			},
		};

		const delivered = bridge.deliver({
			method: "mcpServer/elicitation/request",
			requestId: "app-request-mcp-1",
			params,
		});

		expect(delivered).toMatchObject({
			kind: "delivered",
			request: {
				externalCallbackId: "callback-app-request-mcp-1",
				envelope: {
					externalSessionId: "external-session-1",
					appThreadId: "app-thread-1",
					appTurnId: "app-turn-1",
					appItemId: "app-mcp-elicitation-1",
					appRequestId: "app-request-mcp-1",
					originalMethod: "mcpServer/elicitation/request",
					originalParams: params,
				},
			},
		});

		const response = await bridge.respond({
			externalCallbackId: "callback-app-request-mcp-1",
			response: {
				action: "accept",
				content: { includeEmail: true },
				_meta: { traceId: "trace-mcp-1" },
			},
		});

		expect(response).toEqual({ kind: "forwarded" });
		expect(callbackClient.responses).toEqual([
			{
				appRequestId: "app-request-mcp-1",
				response: {
					action: "accept",
					content: { includeEmail: true },
					_meta: { traceId: "trace-mcp-1" },
				},
			},
		]);
	});

	it("keeps unsupported app-server callbacks explicit instead of auto-approving", () => {
		const { bridge, callbackClient, idMapper } = createMcpDynamicFixture();

		const delivered = bridge.deliver({
			method: "currentTime/read",
			requestId: "app-request-time-1",
			params: { threadId: "app-thread-1" },
		});

		expect(delivered).toMatchObject({
			kind: "adapter-error",
			error: {
				data: { adapterCode: "invalid-callback-state" },
				message: "Unsupported PR-008/PR-009 callback method: currentTime/read",
			},
		});
		expect(callbackClient.responses).toEqual([]);
		expect(callbackClient.rejections).toEqual([]);
		expect(idMapper.getServerRequest("app-request-time-1")).toBeUndefined();
	});

	it("preserves MCP progress, completed structured content, and _meta in item projections", () => {
		const { projector } = createMcpDynamicFixture();
		const progress = projector.project({
			method: "item/mcpToolCall/progress",
			params: {
				threadId: "app-thread-1",
				turnId: "app-turn-1",
				itemId: "app-mcp-tool-1",
				progress: 0.5,
				message: "halfway",
				structuredContent: { completed: 1, total: 2 },
				_meta: { traceId: "trace-progress-1" },
			},
		});
		const completed = projector.project({
			method: "item/completed",
			params: {
				threadId: "app-thread-1",
				turnId: "app-turn-1",
				item: {
					id: "app-mcp-tool-1",
					type: "mcpToolCall",
					serverName: "crm",
					toolName: "enrich_contact",
					content: [{ type: "text", text: "done" }],
					structuredContent: { contactId: "contact-1", enriched: true },
					_meta: { traceId: "trace-progress-1" },
				},
			},
		});

		expect(progress).toMatchObject({
			kind: "semantic",
			channel: "mcp",
			semanticType: "progress",
			streamClass: "best-effort",
			originalParams: {
				structuredContent: { completed: 1, total: 2 },
				_meta: { traceId: "trace-progress-1" },
			},
		});
		expect(completed).toMatchObject({
			kind: "semantic",
			channel: "item",
			semanticType: "item-completed",
			streamClass: "lossless",
			completedItem: {
				structuredContent: { contactId: "contact-1", enriched: true },
				_meta: { traceId: "trace-progress-1" },
			},
		});
	});
});
