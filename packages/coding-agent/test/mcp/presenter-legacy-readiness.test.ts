import { afterEach, expect, it, vi } from "vitest";
import type { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { HostMcpRegistry } from "../../src/core/extensions/builtin/mcp/host-registry.ts";
import { createMcpRequestOrigin, mcpRequestOptions } from "../../src/core/extensions/builtin/mcp/request-origin.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { cleanupRoots, fakePi, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";
import { mrtrTui } from "./fixtures/mrtr-presentation.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	await cleanupRoots(cleanup);
	vi.unstubAllGlobals();
});

// senpi#4210: the real SDK must negotiate again after host authority changes.
it.each([false, true])("renegotiates late grants and revocation on a legacy connection (shared=%s)", async (shared) => {
	const root = makeRoot("late-presenter", cleanup);
	const initializations: unknown[] = [];
	let pending: { id: unknown; stream: ReadableStreamDefaultController<Uint8Array> } | undefined;
	const encode = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: unknown, init?: RequestInit) => {
			if (init?.method !== "POST") return new Response(null, { status: 405 });
			const request = JSON.parse(String(init.body));
			if (request.method === "server/discover")
				return Response.json({
					jsonrpc: "2.0",
					id: request.id,
					error: { code: -32601, message: "Method not found" },
				});
			if (!request.method) {
				if (!pending) throw new Error("Unexpected form result");
				pending.stream.enqueue(
					encode({
						jsonrpc: "2.0",
						id: pending.id,
						result: { content: [{ type: "text", text: JSON.stringify(request.result) }] },
					}),
				);
				pending.stream.close();
				pending = undefined;
				return new Response(null, { status: 202 });
			}
			if (request.id === undefined) return new Response(null, { status: 202 });
			if (request.method === "tools/call") {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(stream) {
							pending = { id: request.id, stream };
							stream.enqueue(
								encode({
									jsonrpc: "2.0",
									id: "question",
									method: "elicitation/create",
									params: {
										message: "Synthetic consent",
										requestedSchema: { type: "object", properties: {} },
									},
								}),
							);
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}
			let result: unknown = {};
			if (request.method === "initialize") {
				initializations.push(request.params.capabilities);
				result = {
					protocolVersion: "2025-11-25",
					capabilities: { tools: {} },
					serverInfo: { name: "fixture", version: "1" },
				};
			}
			if (request.method === "tools/list")
				result = { tools: [{ name: "fixture", inputSchema: { type: "object" } }] };
			if (request.method === "prompts/list") result = { prompts: [] };
			if (request.method === "resources/list") result = { resources: [] };
			if (request.method === "resources/templates/list") result = { resourceTemplates: [] };
			return Response.json({ jsonrpc: "2.0", id: request.id, result });
		}),
	);
	setConfig(root, { fixture: { type: "http", url: "https://example.test/mcp", auth: false, lifecycle: "eager" } });
	const registry = new HostMcpRegistry();
	const service = new McpService(shared ? { mcpRegistry: registry } : {});
	const peer = shared ? new McpService({ mcpRegistry: registry }) : undefined;
	const tui = mrtrTui();
	const writer = new SessionEventWriter(() => {});
	const authority = writer.enableMcpPresenters();
	const shown = vi.fn();
	const admit = vi.fn();
	writer.registerConnection("human", {
		writeRaw: (line) => {
			const frame = JSON.parse(line);
			if (frame.type !== "mcp_form_request") return;
			shown();
			queueMicrotask(() => {
				const sender = writer.getMcpPresenterConnection("human");
				if (!sender) throw new Error("Missing sender");
				const { sessionId, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision } = frame;
				const envelope = { sessionId, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision };
				expect(authority.receive(sender, { ...envelope, type: "mcp_form_presented" })).toEqual({ ok: true });
				expect(
					authority.receive(sender, { ...envelope, type: "mcp_form_response", action: "accept", content: {} }),
				).toEqual({ ok: true });
			});
		},
		waitForBackpressure: async () => {},
	});
	writer.bindMcpForms("session", "durable", tui.ui, admit);
	writer.attachConnectionToSession("human", "session");
	const binding = writer.getMcpFormBinding("session");
	const sender = writer.getMcpPresenterConnection("human");
	if (!binding || !sender) throw new Error("Missing private binding");
	const owner = authority.enroll();
	const registration = owner.register(binding, sender, { kind: "desktop" });
	const transition = async (connection: ServerConnection, trigger: () => void) => {
		const ready = Promise.withResolvers<void>();
		const off = connection.onStateChange(({ state }) => {
			if (state === "connected") ready.resolve();
		});
		const deadline = setTimeout(() => ready.reject(new Error("Legacy connection did not renegotiate")), 5_000);
		try {
			trigger();
			await ready.promise;
		} finally {
			off();
			clearTimeout(deadline);
		}
	};
	try {
		await service.attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: root.cwd, isProjectTrusted: () => true, mode: "rpc", ui: tui.ui },
			fakePi(),
			{ agentDir: root.agentDir },
		);
		expect(await service.whenAttachSettled(10_000)).toBe("settled");
		const connection = service.getConnection("fixture");
		if (!connection) throw new Error("Missing connection");
		if (peer) {
			const peerUi = { ...tui.ui };
			writer.bindMcpForms("peer", "peer-durable", peerUi, () => {});
			await peer.attachSession(
				{ type: "session_start", reason: "startup" },
				{ cwd: root.cwd, isProjectTrusted: () => true, mode: "rpc", ui: peerUi },
				fakePi(),
				{ agentDir: root.agentDir },
			);
			expect(await peer.whenAttachSettled(10_000)).toBe("settled");
			expect(registry.size()).toBe(1);
		}
		expect(initializations).toEqual([{}]);
		await transition(connection, () => {
			owner.acquire(registration);
		});
		expect(initializations).toEqual([{}, { elicitation: {} }]);
		const origin = createMcpRequestOrigin({
			binding,
			connection,
			signal: connection.requestLifetimeSignal,
			privateFormsEnforced: true,
			privateForm: binding.capture(),
			serverLabel: "fixture",
			isCurrent: () => connection.state === "connected",
			resolveAuthority: async () => null,
		});
		await expect(
			connection.client.callTool({ name: "fixture" }, undefined, mcpRequestOptions(origin)),
		).resolves.toMatchObject({
			content: [{ type: "text", text: JSON.stringify({ action: "accept", content: {} }) }],
		});
		expect(shown).toHaveBeenCalledTimes(1);
		expect(admit).toHaveBeenCalledTimes(1);
		expect(writer.getMcpFormBinding("peer")?.capture()).toBeUndefined();
		await transition(connection, () => owner.revoke(registration));
		expect(initializations).toEqual([{}, { elicitation: {} }, {}]);
	} finally {
		await peer?.dispose("quit");
		await service.dispose("quit");
		await registry.dispose();
		writer.unregisterConnection("human");
		authority.dispose();
		tui.lose();
	}
});
