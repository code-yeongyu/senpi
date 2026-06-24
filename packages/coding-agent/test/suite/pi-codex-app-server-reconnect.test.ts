import { describe, expect, it } from "vitest";
import { createIdMapper } from "../../src/core/extensions/builtin/pi-codex-app-server/id-mapper.ts";
import {
	createReconnectResumeCoordinator,
	createResumeToken,
} from "../../src/core/extensions/builtin/pi-codex-app-server/reconnect-resume.ts";
import {
	type AppServerCallbackClient,
	createServerRequestBridge,
} from "../../src/core/extensions/builtin/pi-codex-app-server/server-request-bridge.ts";
import { createSessionRegistry } from "../../src/core/extensions/builtin/pi-codex-app-server/session-registry.ts";

class RecordingReconnectClient {
	readonly calls: { readonly method: string; readonly params: unknown }[] = [];
	private readonly responses: unknown[];

	constructor(responses: readonly unknown[]) {
		this.responses = [...responses];
	}

	async request(method: string, params: unknown): Promise<unknown> {
		this.calls.push({ method, params });
		return this.responses.shift() ?? {};
	}
}

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

function bindActiveSession() {
	const sessionRegistry = createSessionRegistry();
	const bindResult = sessionRegistry.bindSession({
		externalSessionId: "external-session-1",
		appThreadId: "app-thread-1",
		appSessionId: "app-session-1",
	});
	if (bindResult.kind !== "bound") throw new Error("Expected test session binding.");
	return { sessionRegistry, binding: bindResult.binding };
}

describe("pi-codex-app-server reconnect and resume durability", () => {
	it("creates an opaque resume token and reloads authoritative snapshot plus new stream", async () => {
		const { sessionRegistry, binding } = bindActiveSession();
		sessionRegistry.updateReplayCursor("external-session-1", {
			lastCompletedTurnId: "app-turn-1",
			lastProjectedItemId: "app-item-1",
			lastLosslessSequence: 7,
		});
		const active = sessionRegistry.requireActiveSession("external-session-1");
		if (active.kind !== "active") throw new Error("Expected active session.");
		const token = createResumeToken(active.binding);
		const reloadedRegistry = createSessionRegistry();
		const client = new RecordingReconnectClient([
			{ thread: { id: "app-thread-1", session_id: "app-session-1" } },
			{ thread: { id: "app-thread-1", session_id: "app-session-1", name: "Restored" } },
			{ turns: [{ id: "app-turn-1", status: "completed" }] },
			{ items: [{ id: "app-item-1", type: "agentMessage", text: "restored" }] },
		]);
		const coordinator = createReconnectResumeCoordinator({
			connectionId: "connection-2",
			client,
			sessionRegistry: reloadedRegistry,
		});

		const resumed = await coordinator.resumeFromToken(token);

		expect(resumed).toMatchObject({
			kind: "resumed",
			event: {
				method: "resume",
				externalSessionId: "external-session-1",
				appThreadId: "app-thread-1",
				appSessionId: "app-session-1",
				streamClass: "snapshot-authoritative",
				replayCursor: {
					lastCompletedTurnId: "app-turn-1",
					lastProjectedItemId: "app-item-1",
					lastLosslessSequence: 7,
				},
				replayClaim: "snapshot-plus-new-stream",
			},
		});
		expect(client.calls).toEqual([
			{
				method: "thread/resume",
				params: { thread_id: "app-thread-1", session_id: "app-session-1" },
			},
			{ method: "thread/read", params: { thread_id: "app-thread-1" } },
			{
				method: "thread/turns/list",
				params: { thread_id: "app-thread-1", after_turn_id: "app-turn-1" },
			},
			{
				method: "thread/turns/items/list",
				params: { thread_id: "app-thread-1", after_item_id: "app-item-1" },
			},
		]);
		expect(reloadedRegistry.getByExternalSessionId(binding.externalSessionId)).toMatchObject({
			externalSessionId: "external-session-1",
			appThreadId: "app-thread-1",
			appSessionId: "app-session-1",
			tombstoned: false,
		});
	});

	it("rejects tombstoned resume tokens before calling app-server", async () => {
		const { sessionRegistry, binding } = bindActiveSession();
		const token = createResumeToken(binding);
		sessionRegistry.tombstoneExternalSession("external-session-1");
		const client = new RecordingReconnectClient([]);
		const coordinator = createReconnectResumeCoordinator({
			connectionId: "connection-2",
			client,
			sessionRegistry,
		});

		const resumed = await coordinator.resumeFromToken(token);

		expect(resumed).toMatchObject({
			kind: "adapter-error",
			error: { data: { adapterCode: "invalid-session-state" } },
		});
		expect(client.calls).toEqual([]);
	});

	it("updates replay cursor once for terminal notifications and suppresses duplicates", () => {
		const { sessionRegistry } = bindActiveSession();
		const coordinator = createReconnectResumeCoordinator({
			connectionId: "connection-1",
			client: new RecordingReconnectClient([]),
			sessionRegistry,
		});

		const first = coordinator.recordTerminalNotification({
			method: "turn/completed",
			params: {
				threadId: "app-thread-1",
				turnId: "app-turn-1",
				itemId: "app-item-1",
				status: "completed",
			},
			sequence: 11,
		});
		const duplicate = coordinator.recordTerminalNotification({
			method: "turn/completed",
			params: {
				threadId: "app-thread-1",
				turnId: "app-turn-1",
				itemId: "app-item-1",
				status: "completed",
			},
			sequence: 12,
		});

		expect(first).toEqual({
			kind: "recorded",
			externalSessionId: "external-session-1",
			appTurnId: "app-turn-1",
			sequence: 11,
		});
		expect(duplicate).toEqual({
			kind: "duplicate-terminal",
			externalSessionId: "external-session-1",
			appTurnId: "app-turn-1",
		});
		expect(sessionRegistry.getByExternalSessionId("external-session-1")?.replayCursor).toEqual({
			lastCompletedTurnId: "app-turn-1",
			lastProjectedItemId: "app-item-1",
			lastLosslessSequence: 11,
		});
	});

	it("emits disconnect events and replays or rejects pending callbacks after reconnect", async () => {
		const { sessionRegistry } = bindActiveSession();
		const idMapper = createIdMapper(() => 1000);
		const callbackClient = new RecordingCallbackClient();
		const bridge = createServerRequestBridge({
			connectionId: "connection-1",
			capabilityFlags: ["opaque-callbacks"],
			callbackTimeoutMs: 5000,
			nowMs: () => 1000,
			idMapper,
			sessionRegistry,
			callbackClient,
		});
		const delivered = bridge.deliver({
			method: "item/commandExecution/requestApproval",
			requestId: "app-request-1",
			params: {
				threadId: "app-thread-1",
				turnId: "app-turn-1",
				itemId: "app-item-1",
				command: "npm test",
			},
		});
		expect(delivered.kind).toBe("delivered");
		const coordinator = createReconnectResumeCoordinator({
			connectionId: "connection-2",
			client: new RecordingReconnectClient([]),
			sessionRegistry,
		});

		const disconnect = coordinator.createDisconnectEvent("WebSocket closed unexpectedly.");
		const replayed = bridge.replayPendingCallbacks();
		const rejected = await bridge.rejectPendingCallbacks("connection lost during reconnect");

		expect(disconnect).toEqual({
			kind: "disconnect",
			method: "disconnect",
			connectionId: "connection-2",
			streamClass: "control",
			message: "WebSocket closed unexpectedly.",
			replayClaim: "snapshot-plus-new-stream",
		});
		expect(replayed).toHaveLength(1);
		expect(replayed[0]).toMatchObject({
			externalCallbackId: "callback-app-request-1",
			envelope: {
				connectionId: "connection-1",
				appRequestId: "app-request-1",
				originalMethod: "item/commandExecution/requestApproval",
			},
		});
		expect(rejected).toEqual([{ appRequestId: "app-request-1", externalCallbackId: "callback-app-request-1" }]);
		expect(callbackClient.rejections).toEqual([
			{ appRequestId: "app-request-1", reason: "connection lost during reconnect" },
		]);
		expect(idMapper.getServerRequest("app-request-1")).toBeUndefined();
	});
});
