import { clearTimeout as clearRealTimeout, setTimeout as setRealTimeout } from "node:timers";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ExtensionToolHookLifecycleEvent } from "../../../src/core/extensions/runner.ts";
import type { ExtensionError, ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

/** A tool that records each run and returns `probe-ok`. */
export function probeTool(runs: string[]): AgentTool {
	return {
		name: "probe",
		label: "Probe",
		description: "Returns at once.",
		parameters: Type.Object({}),
		execute: async (toolCallId) => {
			runs.push(toolCallId);
			return { content: [{ type: "text", text: "probe-ok" }], details: {} };
		},
	};
}

/** Rejects when `work` has not settled after `ms` of real time: a hang fails the test instead of the run. */
export function withinRealTime<T>(work: Promise<T>, what: string, ms = 5_000): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setRealTimeout(() => reject(new Error(`still waiting for ${what} after ${ms} ms`)), ms);
		work.then(
			(value) => {
				clearRealTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearRealTimeout(timer);
				reject(error);
			},
		);
	});
}

export interface ProbeTurn {
	readonly harness: Harness;
	readonly errors: ExtensionError[];
	readonly runs: string[];
}

/** A session whose model calls `probe` once and then answers `done`, with `extensions` loaded under their paths. */
export async function probeTurnHarness(
	extensions: ReadonlyArray<{ readonly path: string; readonly factory: ExtensionFactory }>,
	settings: Record<string, unknown> = {},
): Promise<ProbeTurn> {
	const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
	const runs: string[] = [];
	const harness = await createHarness({
		tools: [probeTool(runs)],
		extensionFactories: [...extensions],
		fileSettings: true,
		settings,
	});
	const errors: ExtensionError[] = [];
	harness.getExtensionRunner().onError((error) => errors.push(error));
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("probe", {}, { id: "call_probe" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done", { stopReason: "stop" }),
	]);
	return { harness, errors, runs };
}

type HookEnd = Extract<ExtensionToolHookLifecycleEvent, { phase: "end" }>;

/** Each hook run that ended, as `<extension path>:<hook>:<status>`. */
export function hookEnds(harness: Harness): string[] {
	return harness
		.eventsOfType("tool_hook_status")
		.filter((event): event is HookEnd => event.phase === "end")
		.map((event) => `${event.extensionPath}:${event.hookName}:${event.status}`);
}
