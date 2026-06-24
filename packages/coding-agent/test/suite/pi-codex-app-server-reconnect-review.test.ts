import { describe, expect, it } from "vitest";
import { createReconnectResumeCoordinator } from "../../src/core/extensions/builtin/pi-codex-app-server/reconnect-resume.ts";
import { createSessionRegistry } from "../../src/core/extensions/builtin/pi-codex-app-server/session-registry.ts";

class RecordingReconnectClient {
	readonly calls: { readonly method: string; readonly params: unknown }[] = [];

	async request(method: string, params: unknown): Promise<unknown> {
		this.calls.push({ method, params });
		return {};
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
	return sessionRegistry;
}

describe("pi-codex-app-server reconnect review regressions", () => {
	it("updates replay cursor from real app-server nested turn completion shape", () => {
		const sessionRegistry = bindActiveSession();
		const coordinator = createReconnectResumeCoordinator({
			connectionId: "connection-1",
			client: new RecordingReconnectClient(),
			sessionRegistry,
		});

		const recorded = coordinator.recordTerminalNotification({
			method: "turn/completed",
			params: {
				threadId: "app-thread-1",
				turn: { id: "app-turn-nested-1", status: "completed" },
			},
			sequence: 21,
		});

		expect(recorded).toEqual({
			kind: "recorded",
			externalSessionId: "external-session-1",
			appTurnId: "app-turn-nested-1",
			sequence: 21,
		});
		expect(sessionRegistry.getByExternalSessionId("external-session-1")?.replayCursor).toEqual({
			lastCompletedTurnId: "app-turn-nested-1",
			lastLosslessSequence: 21,
		});
	});

	it("preserves existing projected item cursor when terminal completion omits item id", () => {
		const sessionRegistry = bindActiveSession();
		sessionRegistry.updateReplayCursor("external-session-1", {
			lastCompletedTurnId: "app-turn-before",
			lastProjectedItemId: "app-item-before",
			lastLosslessSequence: 20,
		});
		const coordinator = createReconnectResumeCoordinator({
			connectionId: "connection-1",
			client: new RecordingReconnectClient(),
			sessionRegistry,
		});

		const recorded = coordinator.recordTerminalNotification({
			method: "turn/completed",
			params: {
				thread_id: "app-thread-1",
				turn: { id: "app-turn-after", status: "completed" },
			},
			sequence: 22,
		});

		expect(recorded).toMatchObject({
			kind: "recorded",
			appTurnId: "app-turn-after",
			sequence: 22,
		});
		expect(sessionRegistry.getByExternalSessionId("external-session-1")?.replayCursor).toEqual({
			lastCompletedTurnId: "app-turn-after",
			lastProjectedItemId: "app-item-before",
			lastLosslessSequence: 22,
		});
	});
});
