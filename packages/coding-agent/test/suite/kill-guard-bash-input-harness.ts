import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import { type ExtensionAPI, ExecuteToolError } from "../../src/core/extensions/types.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const killGuard = builtinExtensions.find((extension) => extension.id === "kill-guard")?.factory;

function recordingBashInput(ran: string[]): AgentTool {
	return {
		name: "bash_input",
		label: "bash_input",
		description: "records bash_input",
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async (_id, params) => {
			ran.push(JSON.stringify(params));
			return { content: [{ type: "text", text: "ran" }], details: {} };
		},
	};
}

export type Outcome = { readonly blocked: true; readonly text: string } | { readonly blocked: false };

export async function call(harness: Harness, params: Record<string, unknown>): Promise<Outcome> {
	try {
		await harness.session.executeTool("bash_input", params);
		return { blocked: false };
	} catch (error) {
		if (error instanceof ExecuteToolError && error.code === "blocked") return { blocked: true, text: error.message };
		throw error;
	}
}

/** Registers the calling suite's cleanup and returns its setup. */
export function useBashInputHarness() {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});
	return async function setup() {
		if (killGuard === undefined) throw new Error("missing builtin extension: kill-guard");
		const ran: string[] = [];
		const bus: { pi?: ExtensionAPI } = {};
		const harness = await createHarness({
			tools: [recordingBashInput(ran)],
			extensionFactories: [
				killGuard,
				(pi: ExtensionAPI) => {
					bus.pi = pi;
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		// What the terminal extension publishes whenever its set of running background sessions changes.
		const running = (ids: readonly string[]) =>
			bus.pi?.events.emit(WAKE_SOURCE_STATE_EVENT, {
				source: "terminal-background-sessions",
				activeCount: ids.length,
				items: ids.map((id) => ({ id })),
			});
		return { harness, ran, running };
	};
}
