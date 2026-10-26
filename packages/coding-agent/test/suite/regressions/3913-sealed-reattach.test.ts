import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { CreateAgentSessionRuntimeResult } from "../../../src/core/agent-session-runtime.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import type { RpcCommand, RpcResponse } from "../../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { MAX_SHARED_STDIO_QUEUE_RECORDS, SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { fakeSessionBase } from "../../helpers/fake-session-base.ts";

it("refuses sealed reattach and answers old-handle commands instead of silently dropping them", async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "senpi-3913-")));
	const registry = new RpcSessionRegistry({
		agentDir: dir,
		createRuntime: async (options) => {
			new ProjectTrustStore(options.agentDir).set(options.cwd, true);
			return {
				session: {
					...fakeSessionBase(options),
					isFastModeActive: () => false,
					agent: { state: {} },
					isStreaming: false,
					activitySnapshot: {},
					activeWakeSources: [],
					externalAdmission: { list: () => ({ pending: [] }), close: () => {} },
					getContextUsage: () => undefined,
					favoriteModels: [],
					scopedModels: [],
					isBashRunning: false,
					extensionRunner: { hasHandlers: () => false, emit: async () => {} },
					abort: async () => {},
					waitForIdle: async () => {},
					dispose: () => {},
					messages: [],
					pendingMessageCount: 0,
				},
				services: { cwd: options.cwd, agentDir: options.agentDir },
				diagnostics: [],
			} as unknown as CreateAgentSessionRuntimeResult;
		},
	});
	const writer = new SessionEventWriter(
		() => {},
		(_flush) => {},
	);
	const router = new SessionCommandRouter(registry, writer, { cwd: dir }, async (sessionId) => ({
		handle: async (command) => {
			const request = command as RpcCommand;
			writer.enqueue(sessionId, { type: "response", id: request.id, command: request.type, success: true });
		},
		dispose: async () => {},
	}));
	const replies = new Map<string, (record: Record<string, unknown>) => void>();
	const send = async (command: RpcCommand): Promise<Record<string, unknown>> => {
		const reply = Promise.withResolvers<Record<string, unknown>>();
		const id = command.id;
		if (id === undefined) throw new Error("request id required");
		replies.set(id, reply.resolve);
		const timer = setTimeout(() => reply.reject(new Error(`silent request: ${id}`)), 10_000);
		try {
			await writer.withConnection("peer", async () => {
				const response: RpcResponse | undefined = await router.handle(command);
				if (response !== undefined) await writer.enqueueControl(response);
			});
			await writer.flush();
			return await reply.promise;
		} finally {
			clearTimeout(timer);
			replies.delete(id);
		}
	};
	const connect = () =>
		writer.registerConnection("peer", {
			writeRaw: (chunk) => {
				const record = JSON.parse(chunk) as Record<string, unknown>;
				if (typeof record.id === "string") replies.get(record.id)?.(record);
			},
			waitForBackpressure: async () => {},
		});
	try {
		connect();
		const sessionPath = join(dir, "session.jsonl");
		await send({ id: "open", type: "open_session", cwd: dir, sessionPath, retain_on_disconnect: true });
		const sessionId = registry.list()[0]?.sessionId;
		if (sessionId === undefined) throw new Error("missing session");
		await router.releaseConnection("peer");
		writer.unregisterConnection("peer");
		for (let index = 0; index < MAX_SHARED_STDIO_QUEUE_RECORDS; index++)
			writer.enqueue(sessionId, { type: "event", index });
		expect(writer.enqueue(sessionId, { type: "event", index: "overflow" })).toBe(false);
		await writer.flush();
		connect();
		const refused = await send({ id: "reattach", type: "open_session", cwd: dir, sessionPath });
		expect(refused).toMatchObject({
			success: false,
			errorCode: "session_output_overflow",
			errorData: { sessionId, action: "unload_and_reopen" },
		});
		expect(registry.peek(sessionId)?.attachments).toBe(0);
		const state = await send({ id: "state", type: "get_state", sessionId });
		expect(state).toMatchObject({ success: false, errorCode: "session_output_overflow" });
		expect(writer.enqueue(sessionId, { type: "event" })).toBe(false);
		const unloaded = await send({ id: "unload", type: "unload_session", sessionId });
		expect(unloaded).toMatchObject({ success: true, data: { outcome: "unloaded", sessionPath } });
		const reopened = await send({ id: "fresh", type: "open_session", cwd: dir, sessionPath });
		expect(reopened.success).toBe(true);
		const freshSessionId = registry.list()[0]?.sessionId;
		expect(freshSessionId).not.toBe(sessionId);
		if (freshSessionId === undefined) throw new Error("missing fresh session");
		expect(await send({ id: "fresh-state", type: "get_state", sessionId: freshSessionId })).toMatchObject({
			success: true,
		});
	} finally {
		await router.dispose();
		await writer.flush();
		await rm(dir, { recursive: true, force: true });
	}
});
