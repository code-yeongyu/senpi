import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { privateMcpForms, type McpFormRequest } from "../../src/core/mcp-form-types.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { normalizeServer } from "../../src/core/extensions/builtin/mcp/config.ts";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { configureMcpElicitation } from "../../src/core/extensions/builtin/mcp/elicitation.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import { isRecord } from "../../src/core/extensions/builtin/mcp/modern/form-schema.ts";
import {
	beginLegacyMcpOperation,
	createMcpRequestOrigin,
	mcpRequestOptions,
} from "../../src/core/extensions/builtin/mcp/request-origin.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { inputResult, MrtrScript, startMrtrServer } from "./fixtures/mrtr-2026-server.ts";

it.each(["mcp_presenter_context", "mcp_form_sync", "mcp_form_response"])(
	"leaves %s on the ordinary unknown-command path with enforcement off",
	(type) => {
		const writer = new SessionEventWriter(() => {});
		expect(writer.handleMcpForm({ type, sessionId: "session" })).toBe(false);
	},
);

it.each([false, true])("host presenter advertisement follows enforcement (%s)", async (enforced) => {
	const root = await mkdtemp(join(tmpdir(), "presenter-capability-"));
	const records: Record<string, unknown>[] = [];
	const writer = new SessionEventWriter((line) => records.push(JSON.parse(line)));
	const core = createHostCore(
		{
			agentDir: root,
			cwd: root,
			createRuntime: async () => {
				throw new Error("Protocol query must not open a session");
			},
			mcpPresenterEnforcement: enforced,
		},
		writer,
	);
	try {
		await core.handle(JSON.stringify({ type: "get_protocol_info", id: "protocol" }));
		await writer.flush();
		const data = records.find((record) => record.id === "protocol")?.data;
		if (!isRecord(data) || !Array.isArray(data.capabilities)) throw new Error("Missing protocol information");
		expect(data.capabilities.includes("mcp_form_presenter_v1")).toBe(enforced);
	} finally {
		await core.router.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

it("private resolution and the next form survive an outstanding socket drain", async () => {
	const writer = new SessionEventWriter(() => {});
	const authority = writer.enableMcpPresenters();
	const frames: Array<McpFormRequest | { type: string }> = [];
	const drain = Promise.withResolvers<void>();
	writer.registerConnection("human", {
		writeRaw: (line) => frames.push(JSON.parse(line)),
		waitForBackpressure: () => drain.promise,
	});
	writer.bindMcpForms("session", "durable", {}, () => {});
	writer.attachConnectionToSession("human", "session");
	const binding = writer.getMcpFormBinding("session");
	const sender = writer.getMcpPresenterConnection("human");
	if (!binding || !sender) throw new Error("Missing presenter");
	const owner = authority.enroll();
	owner.acquire(owner.register(binding, sender, { kind: "desktop" }));
	const presentation = binding.capture();
	if (!presentation) throw new Error("Missing grant");
	const input = {
		operationId: "operation",
		inputId: "input",
		round: 0,
		server: { label: "fixture", source: "user" as const },
		message: "fixture",
		schema: { type: "object" as const, properties: {} },
		operationSignal: new AbortController().signal,
		presentationSignal: presentation.signal,
		deadlineMs: 1000,
	};
	try {
		const first = presentation.present(input);
		const frame = frames[0] as McpFormRequest;
		const { sessionId, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision } = frame;
		const envelope = { sessionId, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision };
		authority.receive(sender, { ...envelope, type: "mcp_form_presented" });
		authority.receive(sender, { ...envelope, type: "mcp_form_response", action: "accept", content: {} });
		await first;
		expect(frames.map((value) => value.type)).toEqual(["mcp_form_request", "mcp_form_resolved"]);
		const second = presentation.present({ ...input, operationId: "second" });
		expect(frames.map((value) => value.type)).toEqual(["mcp_form_request", "mcp_form_resolved", "mcp_form_request"]);
		binding.dispose();
		expect(await second).toMatchObject({ kind: "operation_aborted" });
	} finally {
		drain.resolve();
		writer.unregisterConnection("human");
		authority.dispose();
	}
});

it.each([false, true])("private MRTR processing failure sends no continuation (ready=%s)", async (ready) => {
	const root = await mkdtemp(join(tmpdir(), "presenter-unavailable-"));
	const script = new MrtrScript([inputResult()]);
	const remote = await startMrtrServer(script);
	const connection = new ServerConnection({
		serverName: "fixture",
		config: normalizeServer({ type: "http", url: remote.url, auth: false }),
		logger: createMcpLogger("fixture", { logDir: root }),
	});
	try {
		await connection.connect();
		const origin = createMcpRequestOrigin({
			binding: {},
			connection,
			signal: connection.requestLifetimeSignal,
			privateFormsEnforced: true,
			privateForm: ready
				? {
						signal: new AbortController().signal,
						ready: () => true,
						present: async () => ({
							kind: "processing_failure",
							source: "host_termination",
							humanAdmission: false,
						}),
					}
				: undefined,
			serverLabel: "fixture",
			isCurrent: () => connection.state === "connected",
			resolveAuthority: async () => null,
		});
		await expect(
			connection.client.callTool({ name: "fixture" }, undefined, mcpRequestOptions(origin)),
		).rejects.toMatchObject({ code: "MCP_MRTR_PROCESSING_UNAVAILABLE", retriable: false });
		expect(script.requests).toHaveLength(1);
		expect(script.requests[0]?.params).toHaveProperty(
			["_meta", "io.modelcontextprotocol/clientCapabilities"],
			ready ? { elicitation: {} } : {},
		);
	} finally {
		await connection.dispose();
		await remote.close();
		await rm(root, { recursive: true, force: true });
	}
});

it.each(["legacy", "modern", "modern-parallel"] as const)(
	"real host isolates an %s form from an automated first subscriber",
	async (era) => {
		const root = await mkdtemp(join(tmpdir(), "presenter-rpc-"));
		const bound = Promise.withResolvers<ExtensionUIContext>();
		let admission = vi.fn();
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: root,
				resourceLoaderOptions: {
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					extensionFactories: [
						(pi) => {
							pi.on("session_start", (_event, ctx) => {
								bound.resolve(ctx.ui);
							});
						},
					],
				},
			});
			const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
			admission = vi.spyOn(created.session, "admitHumanAnswer");
			return { ...created, services, diagnostics: services.diagnostics };
		};
		const publicRecords: Record<string, unknown>[] = [];
		const holderRecords: Record<string, unknown>[] = [];
		const botRecords: Record<string, unknown>[] = [];
		const formArrived = Promise.withResolvers<Record<string, unknown>>();
		const secondForm = Promise.withResolvers<Record<string, unknown>>();
		const writer = new SessionEventWriter((line) => publicRecords.push(JSON.parse(line)));
		const core = createHostCore({ agentDir: root, cwd: root, createRuntime, mcpPresenterEnforcement: true }, writer);
		for (const [id, records] of [
			["bot", botRecords],
			["human", holderRecords],
		] as const)
			writer.registerConnection(id, {
				writeRaw: (line) => {
					const record: Record<string, unknown> = JSON.parse(line);
					records.push(record);
					if (id === "human" && record.type === "mcp_form_request") {
						if (records.filter((entry) => entry.type === "mcp_form_request").length === 1)
							formArrived.resolve(record);
						else secondForm.resolve(record);
					}
				},
				waitForBackpressure: async () => {},
			});
		const command = (peer: string, value: object) =>
			writer.withConnection(peer, () => core.handle(JSON.stringify(value)));
		const script = new MrtrScript([inputResult()]);
		const remote = await startMrtrServer(script);
		const connection = new ServerConnection({
			serverName: "configured-server-canary",
			config: normalizeServer({ type: "http", url: remote.url, auth: false }),
			logger: createMcpLogger("fixture", { logDir: root }),
		});
		const legacy = new Client({ name: "fixture", version: "1" }, { capabilities: { elicitation: {} } });
		const legacyServer = new Server({ name: "fixture", version: "1" }, { capabilities: {} });
		let endLegacy: (() => void) | undefined;
		try {
			await command("bot", {
				type: "set_client_info",
				capabilities: ["interactive_user", "grant_select", "ephemeral_dialogs", "mcp_form_presenter_v1"],
			});
			await command("human", {
				type: "set_client_info",
				capabilities: ["interactive_user", "mcp_form_presenter_v1"],
			});
			await command("bot", { type: "open_session", id: "open", cwd: root, retain_on_disconnect: true });
			await writer.flush();
			const opened = botRecords.find((record) => record.id === "open" && record.type === "response");
			const data = opened?.data;
			if (!isRecord(data) || typeof data.sessionId !== "string") throw new Error("Host did not open a session");
			const sessionId = data.sessionId;
			// The real router attaches by durable session path.
			await command("bot", { type: "get_state", id: "state", sessionId });
			await writer.flush();
			const stateReply = botRecords.find((record) => record.id === "state");
			const state = stateReply?.data;
			if (!isRecord(state) || typeof state.sessionFile !== "string") throw new Error("No session path");
			await command("human", { type: "open_session", id: "attach", cwd: root, sessionPath: state.sessionFile });
			await writer.flush();
			const ui = await bound.promise;
			const binding = writer.getMcpFormBinding(sessionId);
			const holder = writer.getMcpPresenterConnection("human");
			const authority = writer.mcpPresenters;
			if (!binding || !holder || !authority) throw new Error("Private host binding is missing");
			expect(privateMcpForms(ui)).toBe(binding);
			expect(binding.capture()).toBeUndefined();
			// Models/admin peers cannot reach this launch-owner seam.
			const owner = authority.enroll();
			owner.acquire(owner.register(binding, holder, { kind: "desktop" }));
			await connection.connect();
			const presenter = binding.capture();
			if (!presenter) throw new Error("Missing presenter");
			const secondAttempt = Promise.withResolvers<void>();
			const present = presenter.present.bind(presenter);
			let attempts = 0;
			vi.spyOn(presenter, "present").mockImplementation((input) => {
				const pending = present(input);
				if (++attempts === 2) secondAttempt.resolve();
				return pending;
			});
			const origin = createMcpRequestOrigin({
				binding: {},
				connection,
				signal: connection.requestLifetimeSignal,
				privateFormsEnforced: true,
				privateForm: presenter,
				serverLabel: "configured-server-canary",
				isCurrent: () => writer.getMcpFormBinding(sessionId) === binding,
				resolveAuthority: async () => null,
			});
			let result: Promise<unknown>;
			if (era !== "legacy") {
				result = connection.client.callTool({ name: "fixture" }, undefined, mcpRequestOptions(origin));
			} else {
				await configureMcpElicitation(
					legacy,
					Object.assign(() => ui, { enforced: () => true }),
				);
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				await legacyServer.connect(serverTransport);
				await legacy.connect(clientTransport);
				// senpi#4248: missing and ambiguous origins expose the same body-free SDK wire error.
				for (const count of [0, 2]) {
					const ends = Array.from({ length: count }, () => beginLegacyMcpOperation(legacy, origin));
					const reply = Promise.withResolvers<unknown>();
					const onmessage = serverTransport.onmessage;
					serverTransport.onmessage = (message, extra) => {
						if ("id" in message && message.id === "unavailable") reply.resolve(message);
						else onmessage?.(message, extra);
					};
					try {
						await serverTransport.send({
							jsonrpc: "2.0",
							id: "unavailable",
							method: "elicitation/create",
							params: {
								message: "message-canary",
								requestedSchema: { type: "object", properties: { value: { type: "string" } } },
							},
						});
						expect(await reply.promise).toEqual({
							jsonrpc: "2.0",
							id: "unavailable",
							error: { code: -32603, message: "MCP error -32603: Elicitation processing unavailable" },
						});
						expect(holderRecords.filter((record) => record.type === "mcp_form_request")).toHaveLength(0);
						expect(admission).not.toHaveBeenCalled();
					} finally {
						serverTransport.onmessage = onmessage;
						for (const end of ends) end();
					}
				}
				endLegacy = beginLegacyMcpOperation(legacy, origin);
				result = legacyServer.elicitInput({
					message: "message-canary",
					requestedSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
				});
			}
			const form = await formArrived.promise;
			const { sessionId: sid, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision } = form;
			const envelope = {
				sessionId: sid,
				bindingEpoch,
				attachmentEpoch,
				grantId,
				dialogId,
				dialogToken,
				formRevision,
			};
			await command("bot", { type: "get_state", id: "pending-state", sessionId });
			await command("bot", { type: "extension_ui_response", sessionId, uiRequestId: dialogId, value: "forged" });
			await command("bot", {
				...envelope,
				type: "mcp_form_response",
				id: "forged",
				action: "accept",
				content: { value: "forged" },
			});
			await writer.flush();
			expect(admission).not.toHaveBeenCalled();
			expect(JSON.stringify([...publicRecords, ...botRecords])).not.toContain("configured-server-canary");
			expect(JSON.stringify(botRecords)).not.toContain(String(dialogToken));
			expect(botRecords).toContainEqual(
				expect.objectContaining({ id: "forged", error: "presenter_not_authorized" }),
			);
			if (era !== "legacy") expect(script.requests).toHaveLength(1);
			let concurrent: Promise<{ result: unknown } | { error: unknown }> | undefined;
			if (era === "modern-parallel") {
				script.results.push(inputResult("second"));
				const received = script.next("inputResultSent");
				concurrent = connection.client
					.callTool({ name: "parallel-fixture" }, undefined, mcpRequestOptions(origin))
					.then(
						(result) => ({ result }),
						(error) => ({ error }),
					);
				await received;
				await secondAttempt.promise;
				expect(holderRecords.filter((record) => record.type === "mcp_form_request")).toHaveLength(1);
			}
			await command("human", { ...envelope, type: "mcp_form_presented" });
			await command("human", {
				...envelope,
				type: "mcp_form_response",
				action: "accept",
				content: { value: "answer-canary" },
			});
			await result;
			expect(admission).toHaveBeenCalledTimes(1);
			if (era !== "legacy") {
				if (concurrent) {
					const next = await Promise.race([
						secondForm.promise,
						concurrent.then(() => {
							throw new Error("Queued operation settled before presentation");
						}),
					]);
					const secondEnvelope = {
						sessionId,
						bindingEpoch: next.bindingEpoch,
						attachmentEpoch: next.attachmentEpoch,
						grantId: next.grantId,
						dialogId: next.dialogId,
						dialogToken: next.dialogToken,
						formRevision: next.formRevision,
					};
					await command("human", { ...secondEnvelope, type: "mcp_form_presented" });
					await command("human", {
						...secondEnvelope,
						type: "mcp_form_response",
						action: "accept",
						content: { value: "second-answer" },
					});
					expect(await concurrent).toHaveProperty("result");
					expect(admission).toHaveBeenCalledTimes(2);
				}
				expect(script.requests).toHaveLength(concurrent ? 4 : 2);
				expect(script.requests.find((request) => request.params?.inputResponses)?.params?.inputResponses).toEqual({
					question: { action: "accept", content: { value: "answer-canary" } },
				});
			} else expect(await result).toEqual({ action: "accept", content: { value: "answer-canary" } });
			await command("human", { ...envelope, type: "mcp_form_sync", id: "sync" });
			expect(holderRecords.find((record) => record.id === "sync")).not.toHaveProperty("form");
		} finally {
			endLegacy?.();
			await Promise.all([connection.dispose(), legacy.close(), legacyServer.close(), remote.close()]);
			await core.router.dispose();
			vi.restoreAllMocks();
			await rm(root, { recursive: true, force: true });
		}
	},
	30_000,
);
