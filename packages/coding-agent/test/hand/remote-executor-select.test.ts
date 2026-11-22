// S27a (R4.a, brain/hand split): a session whose ToolHost is the remote one runs its tool calls on the hand it is
// linked to, never in its own process; a session without one keeps running them in process.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import {
	cleanupHands,
	handDirs,
	openLink,
	remoteHost,
	runTurn,
	startHand,
	startHandOn,
	toolCall,
	toolResultTexts,
} from "./remote-hand-fixture.ts";

afterEach(cleanupHands);

const ranOnHand: string[] = [];
function handTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "probe",
		label: "Probe",
		description: "Reports where it ran.",
		parameters: Type.Object({ value: Type.Number() }),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			ranOnHand.push(toolCallId);
			return { content: [{ type: "text", text: `hand ${ctx.cwd} ${params.value}` }], details: {} };
		},
	});
	pi.registerTool({
		name: "wait",
		label: "Wait",
		description: "Waits until aborted.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			return { content: [{ type: "text", text: "saw abort" }], details: {} };
		},
	});
}

function sessionProbe(ran: string[]): AgentTool {
	return {
		name: "probe",
		label: "probe",
		description: "the session's own probe",
		parameters: Type.Object({ value: Type.Number() }),
		execute: async (toolCallId) => {
			ran.push(toolCallId);
			return { content: [{ type: "text", text: "session" }], details: {} };
		},
	};
}

describe("remote executor selection (S27a, R4.a)", () => {
	it("runs a session's call on the linked hand, in the scope's root, and never in the session's process", async () => {
		ranOnHand.length = 0;
		const dirs = await handDirs("select");
		const link = openLink();
		startHand(link, dirs, [handTools]);
		const ranInSession: string[] = [];

		const { agent, events } = await runTurn({
			calls: [toolCall("call-1", "probe", { value: 42 })],
			toolHost: remoteHost(link),
			root: dirs.cwd,
			tools: [sessionProbe(ranInSession)],
		});

		expect(ranOnHand).toEqual(["call-1"]);
		expect(ranInSession).toEqual([]);
		expect(toolResultTexts(agent)).toEqual([`hand ${dirs.cwd} 42`]);
		expect(events.map((event) => event.type).filter((type) => type.startsWith("tool_execution"))).toEqual([
			"tool_execution_start",
			"tool_execution_end",
		]);
	});

	it("keeps a session without a remote ToolHost on its in-process tools", async () => {
		const dirs = await handDirs("fused");
		const ranInSession: string[] = [];

		const { agent } = await runTurn({
			calls: [toolCall("call-1", "probe", { value: 42 })],
			root: dirs.cwd,
			tools: [sessionProbe(ranInSession)],
		});

		expect(ranInSession).toEqual(["call-1"]);
		expect(toolResultTexts(agent)).toEqual(["session"]);
	});

	it("returns results in the model's source order and runs an unknown tool nowhere", async () => {
		ranOnHand.length = 0;
		const dirs = await handDirs("order");
		const link = openLink();
		startHand(link, dirs, [handTools]);

		const { agent } = await runTurn({
			calls: [
				toolCall("a", "probe", { value: 1 }),
				toolCall("b", "missing_tool", {}),
				toolCall("c", "probe", { value: 3 }),
			],
			toolHost: remoteHost(link),
			root: dirs.cwd,
		});

		expect(toolResultTexts(agent)).toEqual([
			`hand ${dirs.cwd} 1`,
			"Tool missing_tool not found",
			`hand ${dirs.cwd} 3`,
		]);
		expect(ranOnHand.sort()).toEqual(["a", "c"]);
	});

	it("forwards a session abort to the hand's running call", async () => {
		const dirs = await handDirs("abort");
		const link = openLink();
		let started: () => void = () => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		let sawAbort: () => void = () => {};
		const handAborted = new Promise<void>((resolve) => {
			sawAbort = resolve;
		});
		startHandOn(link, async () => ({
			run: async (call) => {
				started();
				await new Promise<void>((resolve) =>
					call.signal.addEventListener("abort", () => resolve(), { once: true }),
				);
				sawAbort();
				return { content: [{ type: "text", text: "late" }], details: {} };
			},
			isSequential: () => false,
			dispose: async () => {},
		}));
		const host = remoteHost(link);
		const controller = new AbortController();

		const outcome = host.execute(
			{
				scope: { id: "abort-scope", root: dirs.cwd },
				calls: [toolCall("w", "wait", {})],
				mode: "parallel",
			},
			{ signal: controller.signal, emit: () => {} },
		);
		await running;
		controller.abort();
		const { messages } = await outcome;

		expect(messages.map((message) => message.content)).toEqual([[{ type: "text", text: "Tool execution aborted" }]]);
		expect(messages[0]?.isError).toBe(true);
		await handAborted;
	});

	it("turns a hand that is gone into an error result for each call", async () => {
		const dirs = await handDirs("gone");
		const link = openLink();
		const host = remoteHost(link);
		link.brain.close();

		const { messages } = await host.execute(
			{
				scope: { id: "gone-scope", root: dirs.cwd },
				calls: [toolCall("x", "probe", { value: 1 })],
				mode: "parallel",
			},
			{ emit: () => {} },
		);

		expect(messages).toHaveLength(1);
		expect(messages[0]?.isError).toBe(true);
		expect(JSON.stringify(messages[0]?.content)).toContain("The hand is unreachable");
	});
});
