import { describe, expect, it } from "vitest";
import { runAgentLoop, StepCommitError } from "../src/index.ts";
import type { StepCommit } from "../src/types.ts";
import {
	baseConfig,
	contextWith,
	errorStep,
	providerResult,
	run,
	scripted,
	stopStep,
	toolStep,
	user,
} from "./utils/scripted-step-loop.ts";

describe("loop edit 1: AgentLoopConfig.commitStep (C6 custody, CK1)", () => {
	it("leaves today's loop unchanged when commitStep is unset (events, messages, tool dispatch)", async () => {
		const { trace, executed, messages, failure } = await run([toolStep, stopStep]);
		expect(failure).toBeUndefined();
		expect(executed).toEqual(["call-1"]);
		expect(trace).toMatchInlineSnapshot(`
			[
			  "agent_start",
			  "turn_start",
			  "message_start:user",
			  "message_end:user",
			  "message_start:assistant",
			  "message_end:assistant",
			  "message_start:toolResult",
			  "message_end:toolResult",
			  "tool_execution_start:call-1",
			  "tool_execution_end:call-1",
			  "message_start:toolResult",
			  "message_end:toolResult",
			  "turn_end",
			  "turn_start",
			  "message_start:assistant",
			  "message_end:assistant",
			  "turn_end",
			  "agent_end",
			]
		`);
		expect(messages?.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "assistant"]);
	});

	it("commits each step once, after its provider tool results and before tool dispatch or the turn end", async () => {
		const committed: StepCommit[] = [];
		const { trace, executed, failure } = await run([toolStep, stopStep], {
			commitStep: async (step) => {
				committed.push(step);
			},
		});
		expect(failure).toBeUndefined();
		expect(executed).toEqual(["call-1"]);
		expect(committed.map((s) => s.message.stopReason)).toEqual(["toolUse", "stop"]);
		expect(committed[0]?.providerToolResults).toEqual([providerResult]);
		expect(committed[1]?.providerToolResults).toEqual([]);
		const first = trace.indexOf("commit:toolUse:1");
		expect(trace.lastIndexOf("message_end:toolResult", trace.indexOf("tool_execution_start:call-1"))).toBeLessThan(
			first,
		);
		expect(first).toBeLessThan(trace.indexOf("tool_execution_start:call-1"));
		expect(trace.indexOf("commit:stop:0")).toBeLessThan(trace.lastIndexOf("turn_end"));
	});

	it("commits a terminal-failure message too, before the loop ends the turn", async () => {
		const { trace, failure } = await run([errorStep], { commitStep: async () => {} });
		expect(failure).toBeUndefined();
		const commit = trace.indexOf("commit:error:0");
		expect(commit).toBeGreaterThan(trace.indexOf("message_end:assistant"));
		expect(commit).toBeLessThan(trace.indexOf("turn_end"));
	});

	it("a rejected commit leaves the loop: no tool dispatch, no further events, the same error out", async () => {
		const refusal = new StepCommitError("step-1", "fenced");
		const { trace, executed, failure } = await run([toolStep, stopStep], {
			commitStep: async () => {
				throw refusal;
			},
		});
		expect(failure).toBe(refusal);
		expect(executed).toEqual([]);
		expect(trace.at(-1)).toBe("commit:toolUse:1");
	});

	it("adds no await to the loop when commitStep is unset", async () => {
		const ticks = await microtaskTicksFromProviderResultToFinishTurn();
		expect(ticks).toBeLessThan(TICK_CAP);
		expect(ticks).toMatchInlineSnapshot(`1`);
	});
});

const TICK_CAP = 10_000;

async function microtaskTicksFromProviderResultToFinishTurn(): Promise<number> {
	let ticks = 0;
	let running = false;
	const tick = () => {
		if (!running) return;
		ticks++;
		if (ticks >= TICK_CAP) {
			running = false;
			return;
		}
		queueMicrotask(tick);
	};
	await runAgentLoop(
		[user],
		contextWith([]),
		baseConfig({
			finishTurn: () => {
				running = false;
			},
		}),
		(event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "toolResult" &&
				event.message.toolCallId === "srv-1"
			) {
				running = true;
				queueMicrotask(tick);
			}
		},
		undefined,
		scripted([{ ...errorStep, emitProviderResult: true }]),
	);
	running = false;
	return ticks;
}
