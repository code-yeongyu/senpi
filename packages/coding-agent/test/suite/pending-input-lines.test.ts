import { describe, expect, it } from "vitest";
import type { PendingInputProjection } from "../../src/core/pending-input-projection.ts";
import {
	applyPendingInputChanges,
	pendingInputLines,
} from "../../src/modes/interactive/components/pending-input-lines.ts";
import { InteractiveMode, OptimisticUserEchoController } from "../../src/modes/interactive/interactive-mode.ts";

// senpi#3549 P2c: the TUI pending display renders the engine projection, never its own lifecycle.

function projection(
	overrides: Partial<PendingInputProjection> & Pick<PendingInputProjection, "clientMessageId">,
): PendingInputProjection {
	return {
		state: "queued",
		text: "t",
		requestedMode: "followUp",
		revision: 1,
		statusCode: "queued_follow_up",
		statusText: "Queued - sent after this turn",
		actions: ["edit", "remove", "copy"],
		pendingDecoration: true,
		supersededVersions: [],
		...overrides,
	};
}

describe("TUI pending-input lines", () => {
	it("labels each queued input with its engine status, and keeps an input without custody as before", () => {
		const projections = new Map([["c-1", projection({ clientMessageId: "c-1", statusText: "Sending" })]]);

		const lines = pendingInputLines(
			[
				{ text: "steer it", mode: "steer", clientMessageId: "c-1" },
				{ text: "legacy", mode: "followUp" },
			],
			projections,
		);

		expect(lines).toEqual(["Steering: steer it (Sending)", "Follow-up: legacy"]);
	});

	it("keeps a failed input visible after it left the queue", () => {
		const projections = new Map([
			[
				"c-2",
				projection({
					clientMessageId: "c-2",
					state: "failed",
					text: "lost",
					statusText: "Delivery could not be confirmed",
				}),
			],
		]);

		expect(pendingInputLines([], projections)).toEqual(["Delivery could not be confirmed: lost"]);
	});

	it("drops delivered and removed inputs from the display", () => {
		const projections = new Map<string, PendingInputProjection>();
		applyPendingInputChanges(projections, [
			projection({ clientMessageId: "c-1" }),
			projection({ clientMessageId: "c-2" }),
		]);

		applyPendingInputChanges(projections, [
			projection({ clientMessageId: "c-1", state: "delivered" }),
			projection({ clientMessageId: "c-2", state: "removed" }),
		]);

		expect([...projections.keys()]).toEqual([]);
	});

	it("gives every TUI submission its own client id, so queued TUI input enters durable custody", () => {
		const echoes = new OptimisticUserEchoController(() => ({ remove: () => {} }) as never);

		const first = echoes.promptOptions(undefined).clientMessageId;
		const second = echoes.promptOptions(undefined).clientMessageId;

		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(second).not.toBe(first);
	});

	it("draws the queue right after subscribing, so input the store requeued while the session opened shows", () => {
		const subscribe = Reflect.get(InteractiveMode.prototype, "subscribeToAgent");
		const calls: string[] = [];
		const context = {
			session: { subscribe: () => calls.push("subscribed") && (() => {}) },
			handleEvent: async () => {},
			updatePendingMessagesDisplay: () => calls.push("drawn"),
		};

		subscribe.call(context);

		expect(calls).toEqual(["subscribed", "drawn"]);
	});

	it("drops the previous session's projections and draws the queue when a session is rendered", () => {
		const render = Reflect.get(InteractiveMode.prototype, "renderCurrentSessionState");
		const projections = new Map([["old", {}]]);
		let drawn = 0;
		const clear = { clear: () => {} };
		const context = {
			loadedResourcesContainer: clear,
			chatContainer: clear,
			pendingMessagesContainer: clear,
			compactionTransferAbortControllers: new Map(),
			compactionQueueGeneration: 0,
			streamingReveal: { stop: () => {} },
			toolResultReveal: { stop: () => {} },
			assistantTextSegments: new Map(),
			clearPendingTools: () => {},
			clearToolHookStatuses: () => {},
			renderInitialMessages: () => {},
			pendingInputProjections: projections,
			updatePendingMessagesDisplay: () => {
				drawn += 1;
			},
		};

		render.call(context);

		expect(projections.size).toBe(0);
		expect(drawn).toBe(1);
	});
});
