import type { Static } from "typebox";
import { beforeEach, describe, expect, it } from "vitest";
import {
	registerLoopTools,
	SCHEDULE_WAKEUP_TOOL,
	type ScheduleWakeupDetails,
	type ScheduleWakeupParams,
	type ScheduleWakeupScheduledDetails,
	type ScheduleWakeupSchedulerPort,
	type ScheduleWakeupStoppedDetails,
	scheduleWakeupSchema,
} from "../../src/core/extensions/builtin/loop/tools.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "../../src/core/extensions/types.ts";

type WakeupTool = ToolDefinition<typeof scheduleWakeupSchema, ScheduleWakeupDetails, unknown>;
type SchemaParams = Static<typeof scheduleWakeupSchema>;

const NOW = 1_755_500_000_000;
const ctx = {} as ExtensionContext;

type ScheduleCall = Parameters<ScheduleWakeupSchedulerPort["scheduleWakeup"]>[0];
type StopCall = Parameters<ScheduleWakeupSchedulerPort["stopDynamicLoop"]>[0];

class FakeScheduler implements ScheduleWakeupSchedulerPort {
	target: ReturnType<ScheduleWakeupSchedulerPort["getWakeupTarget"]> = {
		kind: "dynamic",
		loopId: "loop-dyn-1",
	};
	replacedWakeupId: string | undefined;
	noopStreak = 0;
	scheduleCalls: ScheduleCall[] = [];
	stopCalls: StopCall[] = [];
	nextWakeupId = "wake-1";

	getWakeupTarget(): ReturnType<ScheduleWakeupSchedulerPort["getWakeupTarget"]> {
		return this.target;
	}

	async scheduleWakeup(request: ScheduleCall) {
		this.scheduleCalls.push(request);
		this.noopStreak = request.noop ? this.noopStreak + 1 : 0;
		return {
			wakeupId: this.nextWakeupId,
			...(this.replacedWakeupId === undefined ? {} : { replacedWakeupId: this.replacedWakeupId }),
			dueAt: NOW + request.delaySeconds * 1000,
			noopStreak: this.noopStreak,
		};
	}

	async stopDynamicLoop(request: StopCall) {
		this.stopCalls.push(request);
		return { endedAt: NOW };
	}
}

function captureTool(scheduler: ScheduleWakeupSchedulerPort): WakeupTool {
	let captured: WakeupTool | undefined;
	const pi = {
		registerTool(tool: WakeupTool) {
			captured = tool;
		},
	} as Pick<ExtensionAPI, "registerTool"> as ExtensionAPI;
	registerLoopTools(pi, { scheduler });
	if (!captured) throw new Error("expected schedule_wakeup to be registered");
	return captured;
}

async function run(tool: WakeupTool, params: ScheduleWakeupParams): Promise<AgentToolResult<ScheduleWakeupDetails>> {
	return tool.execute("call-1", params as SchemaParams, undefined, undefined, ctx);
}

async function runError(tool: WakeupTool, params: ScheduleWakeupParams): Promise<Error> {
	try {
		await run(tool, params);
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected schedule_wakeup to reject");
}

function scheduled(result: AgentToolResult<ScheduleWakeupDetails>): ScheduleWakeupScheduledDetails {
	const details = result.details;
	if (details.action !== "scheduled") throw new Error(`expected scheduled details, got ${details.action}`);
	return details;
}

function stopped(result: AgentToolResult<ScheduleWakeupDetails>): ScheduleWakeupStoppedDetails {
	const details = result.details;
	if (details.action !== "stopped") throw new Error(`expected stopped details, got ${details.action}`);
	return details;
}

describe("schedule_wakeup tool", () => {
	let scheduler: FakeScheduler;
	let tool: WakeupTool;

	beforeEach(() => {
		scheduler = new FakeScheduler();
		tool = captureTool(scheduler);
	});

	describe("registration and schema", () => {
		it("registers the snake_case tool name with sequential execution", () => {
			expect(tool.name).toBe(SCHEDULE_WAKEUP_TOOL);
			expect(tool.name).toBe("schedule_wakeup");
			expect(tool.executionMode).toBe("sequential");
		});

		it("exposes a flat object schema with no bounds on delaySeconds and no root union", () => {
			const json = JSON.parse(JSON.stringify(scheduleWakeupSchema)) as Record<string, unknown>;
			expect(json.type).toBe("object");
			expect(json.additionalProperties).toBe(false);
			expect(json.anyOf).toBeUndefined();
			expect(json.oneOf).toBeUndefined();
			expect(json.allOf).toBeUndefined();

			const properties = json.properties as Record<string, Record<string, unknown>>;
			expect(Object.keys(properties).sort()).toEqual(["delaySeconds", "noop", "prompt", "reason", "stop"]);
			expect(properties.delaySeconds.type).toBe("integer");
			expect(properties.delaySeconds.minimum).toBeUndefined();
			expect(properties.delaySeconds.maximum).toBeUndefined();
			expect(properties.reason.minLength).toBe(1);
			expect(json.required).toEqual(["reason"]);
		});

		it("describes senpi tooling and cache-aware delays, never Claude Code tool names", () => {
			expect(tool.description).toContain("monitor");
			expect(tool.description).toContain("bash_output");
			expect(tool.description).toContain("kill_bash");
			expect(tool.description).toContain("task");
			expect(tool.description).toContain("1200-1800");
			expect(tool.description).not.toContain("Monitor(");
			expect(tool.description).not.toContain("TaskList");
			expect(tool.description).not.toContain("TaskStop");
			expect(tool.description).not.toContain("ScheduleWakeup");
		});
	});

	describe("delay clamping", () => {
		it("clamps a 30s request up to the 60s floor and records both values", async () => {
			const result = await run(tool, { delaySeconds: 30, reason: "poll deploy", prompt: "/loop check the deploy" });
			const details = scheduled(result);
			expect(details.requestedDelaySeconds).toBe(30);
			expect(details.delaySeconds).toBe(60);
			expect(details.clamped).toBe(true);
			expect(scheduler.scheduleCalls[0]?.delaySeconds).toBe(60);
			expect(result.content[0]).toEqual({
				type: "text",
				text: "Scheduled loop loop-dyn-1 in 60s; requested 30s was clamped to the supported 60-3600s range.",
			});
		});

		it("clamps a 99999s request down to the 3600s ceiling", async () => {
			const result = await run(tool, { delaySeconds: 99999, reason: "long hold", prompt: "/loop check the deploy" });
			const details = scheduled(result);
			expect(details.requestedDelaySeconds).toBe(99999);
			expect(details.delaySeconds).toBe(3600);
			expect(details.clamped).toBe(true);
		});

		it("keeps an in-range delay unclamped and reports the plain summary", async () => {
			const result = await run(tool, { delaySeconds: 1200, reason: "idle hold", prompt: "/loop check the deploy" });
			const details = scheduled(result);
			expect(details.delaySeconds).toBe(1200);
			expect(details.requestedDelaySeconds).toBe(1200);
			expect(details.clamped).toBe(false);
			expect(details.dueAt).toBe(NOW + 1_200_000);
			expect(result.content[0]).toEqual({ type: "text", text: "Scheduled loop loop-dyn-1 in 1200s." });
		});

		it("rejects a fractional delay as a validation error instead of clamping it", async () => {
			const error = await runError(tool, { delaySeconds: 1.5, reason: "poll", prompt: "/loop check the deploy" });
			expect(error.message).toContain("delaySeconds");
			expect(error.message).toContain("integer");
			expect(scheduler.scheduleCalls).toHaveLength(0);
		});

		it("rejects a non-finite delay as a validation error", async () => {
			const error = await runError(tool, {
				delaySeconds: Number.POSITIVE_INFINITY,
				reason: "poll",
				prompt: "/loop check the deploy",
			});
			expect(error.message).toContain("delaySeconds");
			expect(scheduler.scheduleCalls).toHaveLength(0);
		});
	});

	describe("schedule branch validation", () => {
		it("errors naming prompt when a non-stop call omits it", async () => {
			const error = await runError(tool, { delaySeconds: 900, reason: "poll" });
			expect(error.message).toBe("prompt is required and must be non-empty unless stop is true.");
			expect(scheduler.scheduleCalls).toHaveLength(0);
		});

		it("errors naming prompt when a non-stop call sends only whitespace", async () => {
			const error = await runError(tool, { delaySeconds: 900, reason: "poll", prompt: "   " });
			expect(error.message).toContain("prompt");
		});

		it("errors naming delaySeconds when a non-stop call omits it", async () => {
			const error = await runError(tool, { reason: "poll", prompt: "/loop check the deploy" });
			expect(error.message).toBe("delaySeconds is required unless stop is true.");
			expect(scheduler.scheduleCalls).toHaveLength(0);
		});

		it("errors naming reason when it is blank", async () => {
			const error = await runError(tool, { delaySeconds: 900, reason: "  ", prompt: "/loop check the deploy" });
			expect(error.message).toContain("reason");
		});

		it("preserves the prompt verbatim, trims the reason, and reports replacement plus noop streak", async () => {
			scheduler.replacedWakeupId = "wake-0";
			const result = await run(tool, {
				delaySeconds: 900,
				reason: "  nothing changed  ",
				prompt: "  /loop check the deploy  ",
				noop: true,
			});
			const details = scheduled(result);
			expect(details.prompt).toBe("  /loop check the deploy  ");
			expect(details.reason).toBe("nothing changed");
			expect(details.noop).toBe(true);
			expect(details.noopStreak).toBe(1);
			expect(details.replacedWakeupId).toBe("wake-0");
			expect(details.wakeupId).toBe("wake-1");
			expect(details.loopId).toBe("loop-dyn-1");
			expect(details.ok).toBe(true);
		});

		it("reports noop false and a reset streak for an actionable iteration", async () => {
			await run(tool, { delaySeconds: 900, reason: "quiet", prompt: "/loop x", noop: true });
			const result = await run(tool, { delaySeconds: 900, reason: "found work", prompt: "/loop x" });
			const details = scheduled(result);
			expect(details.noop).toBe(false);
			expect(details.noopStreak).toBe(0);
		});
	});

	describe("stop branch", () => {
		it("stops the active dynamic loop with terminalReason stopped", async () => {
			const result = await run(tool, { stop: true, reason: "deploy finished" });
			const details = stopped(result);
			expect(details.ok).toBe(true);
			expect(details.terminalReason).toBe("stopped");
			expect(details.loopId).toBe("loop-dyn-1");
			expect(details.reason).toBe("deploy finished");
			expect(details.endedAt).toBe(NOW);
			expect(details.ignoredFields).toEqual([]);
			expect(result.content[0]).toEqual({ type: "text", text: "Stopped dynamic loop loop-dyn-1." });
			expect(scheduler.stopCalls).toHaveLength(1);
			expect(scheduler.scheduleCalls).toHaveLength(0);
		});

		it("rejects noop on a stop call, naming noop", async () => {
			const error = await runError(tool, { stop: true, reason: "done", noop: true });
			expect(error.message).toBe("noop must be omitted when stop is true.");
			expect(scheduler.stopCalls).toHaveLength(0);
		});

		it("rejects a stop call with a blank reason", async () => {
			const error = await runError(tool, { stop: true, reason: "   " });
			expect(error.message).toContain("reason");
			expect(scheduler.stopCalls).toHaveLength(0);
		});

		it("ignores delaySeconds and prompt on a stop call and lists both in ignoredFields", async () => {
			const result = await run(tool, {
				stop: true,
				reason: "done",
				prompt: "/loop check the deploy",
				delaySeconds: 900,
			});
			const details = stopped(result);
			expect(details.ignoredFields).toEqual(["delaySeconds", "prompt"]);
			expect(scheduler.scheduleCalls).toHaveLength(0);
			expect(scheduler.stopCalls).toHaveLength(1);
		});

		it("schedules normally when stop is explicitly false", async () => {
			const result = await run(tool, {
				stop: false,
				delaySeconds: 900,
				reason: "keep going",
				prompt: "/loop check the deploy",
			});
			expect(scheduled(result).delaySeconds).toBe(900);
		});
	});

	describe("context rejection", () => {
		it("rejects when no dynamic loop is active", async () => {
			scheduler.target = null;
			const error = await runError(tool, { delaySeconds: 900, reason: "poll", prompt: "/loop x" });
			expect(error.message).toBe("schedule_wakeup can only be used while a dynamic /loop is active.");
			expect(scheduler.scheduleCalls).toHaveLength(0);
		});

		it("rejects a stop call when no dynamic loop is active", async () => {
			scheduler.target = null;
			const error = await runError(tool, { stop: true, reason: "done" });
			expect(error.message).toBe("schedule_wakeup can only be used while a dynamic /loop is active.");
			expect(scheduler.stopCalls).toHaveLength(0);
		});

		it("rejects a call made from a fixed tick", async () => {
			scheduler.target = { kind: "fixed", loopId: "loop-fixed-1" };
			const error = await runError(tool, { delaySeconds: 900, reason: "poll", prompt: "/loop x" });
			expect(error.message).toBe(
				"This is a fixed /loop tick; the recurring schedule re-arms automatically. Do not call schedule_wakeup.",
			);
			expect(scheduler.scheduleCalls).toHaveLength(0);
		});
	});
});
