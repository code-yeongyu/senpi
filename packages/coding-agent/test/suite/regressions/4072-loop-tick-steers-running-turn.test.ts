/**
 * senpi#4072: a `/loop` tick that comes due while the agent is mid-turn must be steered into that running
 * turn (delivered at the next tool boundary), not parked as a follow-up that only runs after the
 * turn ends. Runs through `createHarness` with the real loop extension and the real session queue,
 * so a regression in either the extension's delivery mode or the session's steer path fails here.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createLoopExtension, type LoopController } from "../../../src/core/extensions/builtin/loop/index.ts";
import type { LoopTimerPort } from "../../../src/core/extensions/builtin/loop/scheduler.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;
const TICK_MARKER = "loop-check-7f3a";

class FakeTimers implements LoopTimerPort {
	readonly armed = new Map<string, () => void>();
	arm(key: string, _dueAt: number, callback: () => void): void {
		this.armed.set(key, callback);
	}
	cancel(key: string): void {
		this.armed.delete(key);
	}
	cancelAll(): void {
		this.armed.clear();
	}
}

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

describe("/loop tick delivery while the agent is mid-turn", () => {
	it("steers a due tick into the running turn instead of queueing a follow-up", async () => {
		let now = T0;
		let seq = 0;
		let controller: LoopController | undefined;
		const timers = new FakeTimers();
		const extension = createLoopExtension({
			clock: { now: () => now },
			timers: () => timers,
			ids: {
				loopId: () => `loop-${++seq}`,
				wakeupId: () => `wakeup-${++seq}`,
				deliveryId: () => `delivery-${++seq}`,
			},
			resolveLoopFile: async () => ({ found: false }),
			onControllerReady: (next) => {
				controller = next;
			},
		});

		let releaseTool: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};

		const harness = await createHarness({ tools: [waitTool], extensionFactories: [extension] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui" });
		if (controller === undefined) throw new Error("loop extension did not publish a controller");

		// Arming a fixed loop runs its first tick right away on the idle session.
		harness.setResponses([fauxAssistantMessage("first tick done")]);
		const created = await controller.startFixed({
			originalArgs: `5m ${TICK_MARKER}`,
			prompt: TICK_MARKER,
			requestedInterval: { value: 5, unit: "m", raw: "5m" },
		});
		if (!created.ok) throw new Error(`loop start failed: ${created.message}`);
		await harness.session.waitForIdle();

		// The user's own turn is parked inside a tool call when the next occurrence comes due.
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("turn reply"),
			fauxAssistantMessage("extra reply"),
		]);
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});
		const userTurn = harness.session.prompt("user question");
		await toolStarted;

		now += 5 * MINUTE;
		await controller.fireDue(created.loopId);

		expect(harness.session.getSteeringMessages().some((text) => text.includes(TICK_MARKER))).toBe(true);
		expect(harness.session.getFollowUpMessages().some((text) => text.includes(TICK_MARKER))).toBe(false);

		releaseTool?.();
		await userTurn;
		await harness.session.waitForIdle();

		// Steered: the tick is read right after the tool result, inside the same turn and before
		// the turn's reply. A follow-up would only appear after "turn reply".
		const messages = harness.session.messages;
		const toolResultIndex = messages.findIndex((message) => message.role === "toolResult");
		const next = messages[toolResultIndex + 1];
		expect(next?.role).toBe("user");
		expect(next === undefined ? "" : getMessageText(next)).toContain(TICK_MARKER);
	});
});
