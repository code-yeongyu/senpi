/**
 * Shared scenarios and tools for the kill-barrier crash-recovery characterization (plan X13).
 *
 * A child process runs one scenario until its barrier tool is inside its body, then the test SIGKILLs it.
 * Every tool body appends its tool call id to a ledger file first, so a re-run on resume is visible.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

export interface KillBarrierCall {
	readonly name: string;
	readonly id: string;
	readonly args: Record<string, unknown>;
}

export interface KillBarrierScenario {
	readonly calls: readonly KillBarrierCall[];
	/** The call whose body is running when the process dies. */
	readonly barrierId: string;
}

const RESTORABLE_QUESTION_ARGS = {
	questions: [{ header: "Library", question: "Which library?", multiSelect: false }],
	waitForAnswer: true,
};

export const KILL_BARRIER_SCENARIOS = {
	"dispatched-body": {
		calls: [{ name: "kill_barrier_body", id: "call-body", args: {} }],
		barrierId: "call-body",
	},
	"unreleased-siblings": {
		calls: [
			{ name: "kill_barrier_quick", id: "call-sibling-done", args: {} },
			{ name: "kill_barrier_body", id: "call-sibling-held", args: {} },
		],
		barrierId: "call-sibling-held",
	},
	// The ask-user tool name stands in for a blocking question that never got its answer: the killed body
	// leaves the same transcript (a toolCall with no result) that the real tool leaves while it waits.
	"pending-question": {
		calls: [{ name: "ask_user_question", id: "call-question", args: RESTORABLE_QUESTION_ARGS }],
		barrierId: "call-question",
	},
	"unparseable-question": {
		calls: [{ name: "ask_user_question", id: "call-question-bad", args: {} }],
		barrierId: "call-question-bad",
	},
} as const satisfies Record<string, KillBarrierScenario>;

export type KillBarrierScenarioName = keyof typeof KILL_BARRIER_SCENARIOS;

export const KILL_BARRIER_LINE_PREFIX = "KILL_BARRIER ";

export interface KillBarrierReport {
	readonly toolCallId: string;
	/** The assistant entry carrying the barrier call is in the flushed session file. */
	readonly durable: boolean;
	readonly sessionFile: string;
}

const ANY_ARGUMENTS = Type.Object({}, { additionalProperties: true });

function recordingTool(name: string, ledger: string, body: () => Promise<string>): AgentTool {
	return {
		name,
		label: name,
		description: `kill-barrier fixture tool ${name}`,
		parameters: ANY_ARGUMENTS,
		execute: async (toolCallId) => {
			appendFileSync(ledger, `${toolCallId}\n`);
			const text = await body();
			return { content: [{ type: "text", text }], details: {} };
		},
	};
}

/**
 * Child-side tools: non-barrier calls finish at once; the barrier waits for every sibling to finish,
 * reports, and never returns.
 */
export function childTools(scenario: KillBarrierScenario, ledger: string, reached: (id: string) => void): AgentTool[] {
	const barrier = scenario.calls.find((call) => call.id === scenario.barrierId);
	if (barrier === undefined) throw new Error(`scenario has no barrier call ${scenario.barrierId}`);
	const siblings = scenario.calls.filter((call) => call.name !== barrier.name);
	const finished = siblings.map(() => Promise.withResolvers<void>());
	const tools = siblings.map((call, index) =>
		recordingTool(call.name, ledger, async () => {
			finished[index]?.resolve();
			return `${call.name} finished`;
		}),
	);
	tools.push(
		recordingTool(barrier.name, ledger, async () => {
			await Promise.all(finished.map((deferred) => deferred.promise));
			reached(barrier.id);
			return new Promise<string>(() => {});
		}),
	);
	return tools;
}

export function resumeTools(scenario: KillBarrierScenario, ledger: string): AgentTool[] {
	const names = [...new Set(scenario.calls.map((call) => call.name))];
	return names.map((name) => recordingTool(name, ledger, async () => `${name} re-ran`));
}

export function readLedger(ledger: string): string[] {
	if (!existsSync(ledger)) return [];
	return readFileSync(ledger, "utf8").split("\n").filter(Boolean);
}
