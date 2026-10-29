/**
 * Shared scenarios, tool and hook for the interrupted-preparation characterization (plan X12).
 *
 * A child process runs one scenario until a call is inside its preparation (its `prepareArguments` shim has
 * run and its `tool_call` handler is waiting), then the test SIGKILLs it. The shim, the handler and the tool
 * body each append one line to a trace file, so any preparation or body that runs again on resume is visible.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

export const PREP_TOOL_NAME = "prep_barrier";

export interface PrepBarrierCall {
	readonly id: string;
	/** The provider's raw arguments; the shim turns `legacy` into `value`. */
	readonly args: { readonly legacy: string; readonly label: string };
}

export interface PrepBarrierScenario {
	readonly calls: readonly PrepBarrierCall[];
	/** The call whose `tool_call` handler is waiting when the process dies. */
	readonly barrierId: string;
}

export const PREP_BARRIER_SCENARIOS = {
	// The only call dies inside its handler chain, after its shim ran.
	"handler-chain": {
		calls: [{ id: "call-prep", args: { legacy: "7", label: "prep" } }],
		barrierId: "call-prep",
	},
	// The first call finished preparation and waits for release; the second dies inside its handler chain.
	"prepared-sibling": {
		calls: [
			{ id: "call-ready", args: { legacy: "1", label: "ready" } },
			{ id: "call-held", args: { legacy: "2", label: "held" } },
		],
		barrierId: "call-held",
	},
} as const satisfies Record<string, PrepBarrierScenario>;

export type PrepBarrierScenarioName = keyof typeof PREP_BARRIER_SCENARIOS;

export const PREP_BARRIER_LINE_PREFIX = "PREP_BARRIER ";

export interface PrepBarrierReport {
	readonly toolCallId: string;
	/** The assistant entry carrying the barrier call is in the flushed session file. */
	readonly durable: boolean;
	readonly sessionFile: string;
}

const PREPARED_ARGUMENTS = Type.Object({ value: Type.Number(), label: Type.String() });

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function prepBarrierTool(trace: string): AgentTool<typeof PREPARED_ARGUMENTS> {
	return {
		name: PREP_TOOL_NAME,
		label: PREP_TOOL_NAME,
		description: "prep-barrier fixture tool",
		parameters: PREPARED_ARGUMENTS,
		prepareArguments: (raw) => {
			const args = isRecord(raw) ? raw : {};
			const label = typeof args.label === "string" ? args.label : "";
			appendFileSync(trace, `shim:${label}\n`);
			return { value: Number(args.legacy), label };
		},
		execute: async (toolCallId, params) => {
			appendFileSync(trace, `body:${toolCallId}(${params.value})\n`);
			return { content: [{ type: "text", text: `ran ${params.label}` }], details: {} };
		},
	};
}

/**
 * The `tool_call` handler: it records the call and the prepared value it was handed. For the barrier call it
 * reports and never settles, so the process dies inside preparation.
 */
export function prepBarrierHook(trace: string, barrier?: { id: string; reached: (id: string) => void }) {
	return (pi: ExtensionAPI) => {
		pi.on("tool_call", (event) => {
			if (event.toolName !== PREP_TOOL_NAME) return undefined;
			appendFileSync(trace, `hook:${event.toolCallId}(${String(event.input.value)})\n`);
			if (barrier === undefined || event.toolCallId !== barrier.id) return undefined;
			barrier.reached(event.toolCallId);
			return new Promise<undefined>(() => {});
		});
	};
}

export function readTrace(trace: string): string[] {
	if (!existsSync(trace)) return [];
	return readFileSync(trace, "utf8").split("\n").filter(Boolean);
}
