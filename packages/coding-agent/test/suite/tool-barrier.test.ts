import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

/**
 * The session tool barrier (senpi#3717): while a turn is armed, a tool that may change the workspace
 * waits until the barrier is released, its ceiling passes, or the run is aborted; read-only tools run
 * at once. Contract owner for `AgentSession.armToolBarrier` / `releaseToolBarrier`, the
 * `tool_barrier_waiting` / `tool_barrier_expired` events, and `workspaceEffect` classification.
 */

const BARRIER = { id: "turn-1", deadlineMs: 60_000 } as const;

function barrierTools(ran: string[]) {
	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "mutate",
			label: "mutate",
			description: "Changes the workspace.",
			parameters: Type.Object({}),
			execute: async () => {
				ran.push("mutate");
				return { content: [{ type: "text", text: "mutated" }], details: {} };
			},
		});
		pi.registerTool({
			name: "peek",
			label: "peek",
			description: "Looks at the workspace.",
			parameters: Type.Object({}),
			workspaceEffect: "read",
			execute: async () => {
				ran.push("peek");
				return { content: [{ type: "text", text: "peeked" }], details: {} };
			},
		});
	};
}

describe("session tool barrier", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(ran: string[], extra: Array<(pi: ExtensionAPI) => void> = []): Promise<Harness> {
		const harness = await createHarness({
			initialActiveToolNames: ["read"],
			extensionFactories: [barrierTools(ran), ...extra],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return harness;
	}

	it("holds a write tool until the barrier is released, then runs it", async () => {
		const ran: string[] = [];
		const harness = await setup(ran);
		const order: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type !== "tool_barrier_waiting") return;
			order.push(`waiting:${event.toolName}:${event.id}`);
			expect(ran).toEqual([]);
			order.push(`released:${harness.session.releaseToolBarrier(BARRIER.id)}`);
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mutate", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go", { toolBarrier: BARRIER });

		expect(order).toEqual(["waiting:mutate:turn-1", "released:true"]);
		expect(ran).toEqual(["mutate"]);
		expect(getToolResult(harness, "mutate").isError).toBe(false);
	});

	it("runs read tools at once and clears the barrier at the turn's agent_end", async () => {
		const ran: string[] = [];
		const harness = await setup(ran);
		writeFileSync(join(harness.tempDir, "note.txt"), "hello");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("peek", {}), fauxToolCall("read", { path: "note.txt" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		// Never released and a long ceiling: only read classification lets this turn finish.
		await harness.session.prompt("go", { toolBarrier: BARRIER });

		expect(ran).toEqual(["peek"]);
		expect(getToolResult(harness, "read").isError).toBe(false);
		expect(harness.eventsOfType("tool_barrier_waiting")).toEqual([]);
		// The turn's agent_end cleared it: a late release and an unknown id are both no-ops.
		expect(harness.session.releaseToolBarrier(BARRIER.id)).toBe(false);
		expect(harness.session.releaseToolBarrier("never-armed")).toBe(false);
	});

	it("settles the turn as aborted when Stop arrives during the wait", async () => {
		const ran: string[] = [];
		const hooked: string[] = [];
		const harness = await setup(ran, [
			(pi) => {
				pi.on("tool_call", (event) => {
					hooked.push(event.toolName);
				});
			},
		]);
		harness.session.subscribe((event) => {
			if (event.type === "tool_barrier_waiting") void harness.session.abort();
		});
		harness.setResponses([fauxAssistantMessage([fauxToolCall("mutate", {})], { stopReason: "toolUse" })]);

		await harness.session.prompt("go", { toolBarrier: BARRIER });
		await harness.session.waitForIdle();

		expect(ran).toEqual([]);
		expect(getToolResult(harness, "mutate").isError).toBe(true);
		expect(harness.eventsOfType("tool_barrier_expired")).toEqual([]);
		expect(harness.session.isStreaming).toBe(false);
		expect(hooked).toEqual([]);
		expect(harness.session.releaseToolBarrier(BARRIER.id)).toBe(false);
	});

	it("blocks a nested executeTool call that Stop released, even when its tool_call hook would deny it", async () => {
		const ran: string[] = [];
		const hooked: string[] = [];
		const harness = await setup(ran, [
			(pi) => {
				pi.on("tool_call", (event) => {
					hooked.push(event.toolName);
					if (event.toolName === "mutate") return { block: true, reason: "denied" };
					return undefined;
				});
				pi.registerTool({
					name: "outer",
					label: "outer",
					description: "Reads, then asks for a write.",
					parameters: Type.Object({}),
					workspaceEffect: "read",
					execute: async () => {
						try {
							await pi.executeTool("mutate", {});
							ran.push("outer-ok");
						} catch (error) {
							ran.push(`outer-err:${error instanceof Error ? error.message : String(error)}`);
						}
						return { content: [{ type: "text", text: "outer" }], details: {} };
					},
				});
			},
		]);
		harness.session.subscribe((event) => {
			if (event.type === "tool_barrier_waiting") void harness.session.abort();
		});
		harness.setResponses([fauxAssistantMessage([fauxToolCall("outer", {})], { stopReason: "toolUse" })]);

		await harness.session.prompt("go", { toolBarrier: BARRIER });
		await harness.session.waitForIdle();

		expect(ran).not.toContain("mutate");
		expect(ran).not.toContain("outer-ok");
		// The Stop is what refused the call, not the denying hook: the hook saw only the read-only outer call
		// (#3722 review), and the nested call reports the abort rather than the hook's denial.
		expect(hooked).toEqual(["outer"]);
		expect(ran).toEqual(["outer-err:Operation aborted"]);
	});

	it("opens at the ceiling and reports tool_barrier_expired", async () => {
		const ran: string[] = [];
		const harness = await setup(ran);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		harness.session.subscribe((event) => {
			if (event.type === "tool_barrier_waiting") vi.advanceTimersByTime(BARRIER.deadlineMs);
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mutate", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go", { toolBarrier: BARRIER });

		expect(harness.eventsOfType("tool_barrier_expired")).toEqual([
			{ type: "tool_barrier_expired", id: BARRIER.id, deadlineMs: BARRIER.deadlineMs },
		]);
		expect(ran).toEqual(["mutate"]);
		expect(harness.session.releaseToolBarrier(BARRIER.id)).toBe(false);
	});

	it("leaves a turn without a barrier unchanged", async () => {
		const ran: string[] = [];
		const harness = await setup(ran);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mutate", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(ran).toEqual(["mutate"]);
		expect(harness.events.filter((event) => event.type.startsWith("tool_barrier_"))).toEqual([]);
	});

	it("does not carry the barrier into a turn drained from the follow-up queue", async () => {
		const ran: string[] = [];
		const harness = await setup(ran);
		let queued = false;
		harness.session.subscribe((event) => {
			if (event.type !== "agent_start" || queued) return;
			queued = true;
			void harness.session.followUp("next");
		});
		harness.setResponses([
			fauxAssistantMessage("first turn, no tools"),
			fauxAssistantMessage([fauxToolCall("mutate", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go", { toolBarrier: BARRIER });
		await harness.session.waitForIdle();

		expect(ran).toEqual(["mutate"]);
		expect(harness.eventsOfType("tool_barrier_waiting")).toEqual([]);
	});

	it("lets an extension arm the barrier for the turn it starts", async () => {
		const ran: string[] = [];
		const harness = await setup(ran, [
			(pi) => {
				pi.on("before_agent_start", () => {
					pi.armToolBarrier({ id: "ext", deadlineMs: 60_000 });
				});
			},
		]);
		harness.session.subscribe((event) => {
			if (event.type === "tool_barrier_waiting") harness.session.releaseToolBarrier(event.id);
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mutate", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(harness.eventsOfType("tool_barrier_waiting").map((event) => event.id)).toEqual(["ext"]);
		expect(ran).toEqual(["mutate"]);
	});

	it("rejects a malformed barrier before the prompt is accepted", async () => {
		const harness = await setup([]);
		await expect(harness.session.prompt("go", { toolBarrier: { id: "", deadlineMs: 10 } })).rejects.toThrow(/id/);
		await expect(harness.session.prompt("go", { toolBarrier: { id: "x", deadlineMs: 0 } })).rejects.toThrow(
			/deadlineMs/,
		);
		expect(harness.session.messages).toEqual([]);
	});
});
