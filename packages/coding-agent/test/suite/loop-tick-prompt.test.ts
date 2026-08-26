import { describe, expect, it } from "vitest";
import {
	buildTickMessage,
	type LoopFileSnapshot,
	type TickPromptInput,
} from "../../src/core/extensions/builtin/loop/tick-prompt.ts";
import type { SentinelDeliveryState } from "../../src/core/extensions/builtin/loop/types.ts";

const CLAUDE_TOOL_NAMES = ["Monitor", "TaskList", "TaskStop"];

const FIRST_DELIVERY: SentinelDeliveryState = {
	autonomousPreambleDelivered: false,
	lastLoopFileDelivered: null,
	forceFullDelivery: false,
};

function loopFile(overrides: Partial<LoopFileSnapshot> = {}): LoopFileSnapshot {
	return {
		present: true,
		path: "/repo/.senpi/loop.md",
		content: "- check the deploy dashboard\n- triage flaky tests",
		mtimeMs: 1_700_000_000_000,
		size: 52,
		contentHash: "hash-a",
		...overrides,
	} as LoopFileSnapshot;
}

function sentinelInput(overrides: Partial<TickPromptInput> = {}): TickPromptInput {
	return {
		loopId: "loop-1",
		deliveryId: "delivery-1",
		mode: "dynamic",
		payload: { type: "sentinel", sentinel: "<<loop.md-dynamic>>" },
		reentryPrompt: "/loop",
		deliveryState: FIRST_DELIVERY,
		loopFile: loopFile(),
		...overrides,
	} as TickPromptInput;
}

function expectNoClaudeToolNames(text: string): void {
	for (const name of CLAUDE_TOOL_NAMES) {
		expect(text).not.toContain(name);
	}
}

describe("buildTickMessage - prompt payloads", () => {
	it("delivers a fixed prompt tick verbatim and forbids schedule_wakeup", () => {
		const result = buildTickMessage({
			loopId: "loop-fixed",
			deliveryId: "d1",
			mode: "fixed",
			payload: { type: "prompt", prompt: "/babysit-prs" },
			reentryPrompt: "/loop 5m /babysit-prs",
			deliveryState: FIRST_DELIVERY,
			loopFile: { present: false },
		});

		expect(result.delivery).toBe("prompt");
		expect(result.text).toContain("/babysit-prs");
		expect(result.text).toContain("recurring schedule");
		expect(result.text).toContain("do not call `schedule_wakeup`");
		expect(result.details.mode).toBe("fixed");
		expect(result.details.sentinel).toBeUndefined();
		expect(result.deliveryState).toEqual(FIRST_DELIVERY);
		expectNoClaudeToolNames(result.text);
	});

	it("delivers a dynamic prompt tick with the schedule_wakeup-last contract", () => {
		const result = buildTickMessage({
			loopId: "loop-dyn",
			deliveryId: "d2",
			mode: "dynamic",
			payload: { type: "prompt", prompt: "check the deploy" },
			reentryPrompt: "/loop check the deploy",
			deliveryState: FIRST_DELIVERY,
			loopFile: { present: false },
		});

		expect(result.delivery).toBe("prompt");
		expect(result.text).toContain("check the deploy");
		expect(result.text).toContain("last action of this turn");
		expect(result.text).toContain("`schedule_wakeup`");
		expect(result.text).toContain("/loop check the deploy");
		expect(result.text).toContain("{ stop: true }");
		expect(result.text).toContain("`monitor`");
		expect(result.text).toContain("`bash_output`");
		expect(result.text).toContain("`kill_bash`");
		expect(result.text).toContain("task-notification");
		expect(result.details.delivery).toBe("prompt");
		expectNoClaudeToolNames(result.text);
	});
});

describe("buildTickMessage - loop.md sentinels", () => {
	it("sends the full loop.md block with content on the first delivery", () => {
		const result = buildTickMessage(sentinelInput());

		expect(result.delivery).toBe("full");
		expect(result.text).toContain("# /loop tick - loop.md tasks");
		expect(result.text).toContain("- check the deploy dashboard");
		expect(result.text).toContain("instructions for this tick and every subsequent tick");
		expect(result.text).toContain("---");
		expect(result.deliveryState.lastLoopFileDelivered).toEqual({
			path: "/repo/.senpi/loop.md",
			mtimeMs: 1_700_000_000_000,
			size: 52,
			contentHash: "hash-a",
			anchorDeliveryId: "delivery-1",
		});
		expect(result.deliveryState.forceFullDelivery).toBe(false);
		expect(result.details.loopFile?.anchorDeliveryId).toBe("delivery-1");
		expectNoClaudeToolNames(result.text);
	});

	it("sends a reminder without the file content on an unchanged second tick", () => {
		const first = buildTickMessage(sentinelInput());
		const second = buildTickMessage(sentinelInput({ deliveryId: "delivery-2", deliveryState: first.deliveryState }));

		expect(second.delivery).toBe("reminder");
		expect(second.text).toContain("# /loop tick - loop.md tasks");
		expect(second.text).not.toContain("- check the deploy dashboard");
		expect(second.text).toContain("most recent full loop.md instruction message");
		// The reminder must keep the original anchor, not re-anchor on itself.
		expect(second.deliveryState.lastLoopFileDelivered?.anchorDeliveryId).toBe("delivery-1");
		expectNoClaudeToolNames(second.text);
	});

	it("returns to full when the fingerprint changes", () => {
		const first = buildTickMessage(sentinelInput());

		const changedHash = buildTickMessage(
			sentinelInput({
				deliveryId: "d-hash",
				deliveryState: first.deliveryState,
				loopFile: loopFile({ contentHash: "hash-b", content: "- new task" }),
			}),
		);
		expect(changedHash.delivery).toBe("full");
		expect(changedHash.text).toContain("- new task");

		const changedMtime = buildTickMessage(
			sentinelInput({
				deliveryId: "d-mtime",
				deliveryState: first.deliveryState,
				loopFile: loopFile({ mtimeMs: 1_700_000_999_000 }),
			}),
		);
		expect(changedMtime.delivery).toBe("full");

		const changedSize = buildTickMessage(
			sentinelInput({
				deliveryId: "d-size",
				deliveryState: first.deliveryState,
				loopFile: loopFile({ size: 999 }),
			}),
		);
		expect(changedSize.delivery).toBe("full");

		const changedPath = buildTickMessage(
			sentinelInput({
				deliveryId: "d-path",
				deliveryState: first.deliveryState,
				loopFile: loopFile({ path: "/home/u/.senpi/loop.md" }),
			}),
		);
		expect(changedPath.delivery).toBe("full");
		expect(changedPath.deliveryState.lastLoopFileDelivered?.path).toBe("/home/u/.senpi/loop.md");
	});

	it("forces full when forceFullDelivery is set even though nothing changed", () => {
		const first = buildTickMessage(sentinelInput());
		const forced = buildTickMessage(
			sentinelInput({
				deliveryId: "d-forced",
				deliveryState: { ...first.deliveryState, forceFullDelivery: true },
			}),
		);

		expect(forced.delivery).toBe("full");
		expect(forced.text).toContain("- check the deploy dashboard");
		expect(forced.deliveryState.forceFullDelivery).toBe(false);
		expect(forced.deliveryState.lastLoopFileDelivered?.anchorDeliveryId).toBe("d-forced");
	});

	it("keeps the loop alive when the loop file is absent and returns to full on reappearance", () => {
		const first = buildTickMessage(sentinelInput());

		const absent = buildTickMessage(
			sentinelInput({
				deliveryId: "d-absent",
				deliveryState: first.deliveryState,
				loopFile: { present: false },
			}),
		);
		expect(absent.delivery).toBe("full");
		expect(absent.text).toContain("# /loop tick - loop.md absent (dynamic pacing)");
		expect(absent.text).toContain("currently absent");
		expect(absent.text).toContain("Keep the loop alive");
		expect(absent.text).toContain("`schedule_wakeup`");
		expect(absent.deliveryState.lastLoopFileDelivered).toBeNull();
		expect(absent.details.sentinel).toBe("<<loop.md-dynamic>>");
		expectNoClaudeToolNames(absent.text);

		const reappeared = buildTickMessage(sentinelInput({ deliveryId: "d-back", deliveryState: absent.deliveryState }));
		expect(reappeared.delivery).toBe("full");
		expect(reappeared.text).toContain("- check the deploy dashboard");
		expect(reappeared.deliveryState.lastLoopFileDelivered?.anchorDeliveryId).toBe("d-back");
	});

	it("uses the fixed loop.md wording without dynamic pacing", () => {
		const result = buildTickMessage(
			sentinelInput({ mode: "fixed", payload: { type: "sentinel", sentinel: "<<loop.md>>" } }),
		);

		expect(result.delivery).toBe("full");
		expect(result.text).toContain("recurring schedule");
		expect(result.text).toContain("do not call `schedule_wakeup`");
		expect(result.text).not.toContain("dynamic pacing");
		expectNoClaudeToolNames(result.text);

		const absent = buildTickMessage(
			sentinelInput({
				mode: "fixed",
				payload: { type: "sentinel", sentinel: "<<loop.md>>" },
				deliveryId: "d-fixed-absent",
				deliveryState: result.deliveryState,
				loopFile: { present: false },
			}),
		);
		expect(absent.text).toContain("# /loop tick - loop.md absent");
		expect(absent.text).not.toContain("dynamic pacing");
		expect(absent.text).toContain("do not call `schedule_wakeup`");
	});
});

describe("buildTickMessage - autonomous sentinels", () => {
	it("delivers the full dynamic autonomous preamble first, then a reminder", () => {
		const input = sentinelInput({
			payload: { type: "sentinel", sentinel: "<<autonomous-loop-dynamic>>" },
			loopFile: { present: false },
		});

		const full = buildTickMessage(input);
		expect(full.delivery).toBe("full");
		expect(full.text).toContain("# Autonomous loop tick (dynamic pacing)");
		expect(full.text).toContain("last action of this turn");
		expect(full.text).toContain("{ stop: true }");
		expect(full.text).toContain("`monitor`");
		expect(full.text).toContain("`bash_output`");
		expect(full.text).toContain("`kill_bash`");
		expect(full.text).toContain("task-notification");
		expect(full.deliveryState.autonomousPreambleDelivered).toBe(true);
		expectNoClaudeToolNames(full.text);

		const reminder = buildTickMessage({
			...input,
			deliveryId: "d-auto-2",
			deliveryState: full.deliveryState,
		});
		expect(reminder.delivery).toBe("reminder");
		expect(reminder.text).toContain("# Autonomous loop tick (dynamic pacing)");
		expect(reminder.text).not.toContain("Avoid repeating unchanged status");
		expect(reminder.text).toContain("`schedule_wakeup`");
		expectNoClaudeToolNames(reminder.text);
	});

	it("delivers the fixed autonomous preamble and forbids schedule_wakeup", () => {
		const input = sentinelInput({
			mode: "fixed",
			payload: { type: "sentinel", sentinel: "<<autonomous-loop>>" },
			loopFile: { present: false },
		});

		const full = buildTickMessage(input);
		expect(full.delivery).toBe("full");
		expect(full.text).toContain("# Autonomous loop tick");
		expect(full.text).not.toContain("(dynamic pacing)");
		expect(full.text).toContain("recurring schedule");
		expect(full.text).toContain("do not call `schedule_wakeup`");
		expectNoClaudeToolNames(full.text);

		const reminder = buildTickMessage({
			...input,
			deliveryId: "d-auto-fixed-2",
			deliveryState: full.deliveryState,
		});
		expect(reminder.delivery).toBe("reminder");
		expect(reminder.text).toContain("do not call `schedule_wakeup`");
		expectNoClaudeToolNames(reminder.text);
	});

	it("forces a full autonomous preamble again after compaction", () => {
		const input = sentinelInput({
			payload: { type: "sentinel", sentinel: "<<autonomous-loop-dynamic>>" },
			loopFile: { present: false },
		});
		const full = buildTickMessage(input);
		const forced = buildTickMessage({
			...input,
			deliveryId: "d-auto-forced",
			deliveryState: { ...full.deliveryState, forceFullDelivery: true },
		});

		expect(forced.delivery).toBe("full");
		expect(forced.text).toContain("Avoid repeating unchanged status");
		expect(forced.deliveryState.forceFullDelivery).toBe(false);
	});
});

describe("buildTickMessage - invariants across every tick shape", () => {
	const shapes: TickPromptInput[] = [
		sentinelInput(),
		sentinelInput({ mode: "fixed", payload: { type: "sentinel", sentinel: "<<loop.md>>" } }),
		sentinelInput({
			payload: { type: "sentinel", sentinel: "<<autonomous-loop-dynamic>>" },
			loopFile: { present: false },
		}),
		sentinelInput({
			mode: "fixed",
			payload: { type: "sentinel", sentinel: "<<autonomous-loop>>" },
			loopFile: { present: false },
		}),
		sentinelInput({ loopFile: { present: false } }),
		sentinelInput({
			mode: "fixed",
			payload: { type: "prompt", prompt: "/babysit-prs" },
			reentryPrompt: "/loop 5m /babysit-prs",
		}),
		sentinelInput({ payload: { type: "prompt", prompt: "check the deploy" } }),
	];

	it("never emits Claude Code tool names and always reports its own delivery details", () => {
		for (const shape of shapes) {
			const first = buildTickMessage(shape);
			const second = buildTickMessage({ ...shape, deliveryState: first.deliveryState });
			for (const result of [first, second]) {
				expectNoClaudeToolNames(result.text);
				expect(result.text.length).toBeGreaterThan(0);
				expect(result.details.loopId).toBe(shape.loopId);
				expect(result.details.deliveryId).toBe(shape.deliveryId);
				expect(result.details.mode).toBe(shape.mode);
				expect(result.details.delivery).toBe(result.delivery);
			}
		}
	});

	it("states the correct rescheduling rule for every mode", () => {
		for (const shape of shapes) {
			const result = buildTickMessage(shape);
			if (shape.mode === "fixed") {
				expect(result.text).toContain("do not call `schedule_wakeup`");
				expect(result.text).not.toContain("last action of this turn");
			} else {
				expect(result.text).toContain("last action of this turn");
				expect(result.text).not.toContain("do not call `schedule_wakeup`");
			}
		}
	});
});
