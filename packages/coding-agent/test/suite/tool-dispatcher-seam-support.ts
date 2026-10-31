import { Type } from "typebox";
import type { ExtensionFactory, ToolDefinition } from "../../src/core/sdk.ts";
import type { ToolDispatchedInfo } from "../../src/core/tool-dispatch/tool-dispatcher.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import type { Harness } from "./harness.ts";

export function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function stripVolatile(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value, (key, entry) => (key === "wall_time_seconds" ? 0 : entry)));
}

export function fakeBashOperations(output: string): BashOperations & { commands: string[] } {
	const commands: string[] = [];
	return {
		commands,
		exec: async (command, _cwd, { onData }) => {
			commands.push(command);
			onData(Buffer.from(output));
			return { exitCode: 0 };
		},
	};
}

const probeParameters = Type.Object({ value: Type.String() });

export const probeDefinition: ToolDefinition<typeof probeParameters> = {
	name: "seam_probe",
	label: "Seam probe",
	description: "Deterministic probe tool",
	parameters: probeParameters,
	async execute(toolCallId, params, _signal, onUpdate) {
		onUpdate?.({ content: [{ type: "text", text: "partial" }], details: undefined });
		return { content: [{ type: "text", text: `${toolCallId}:${params.value}` }], details: { value: params.value } };
	},
};

export function hookCounters(): {
	factory: ExtensionFactory;
	toolCallHooks: string[];
	toolResultHooks: string[];
} {
	const toolCallHooks: string[] = [];
	const toolResultHooks: string[] = [];
	const factory: ExtensionFactory = (pi) => {
		pi.on("tool_call", (event) => {
			toolCallHooks.push(event.toolName);
			return undefined;
		});
		pi.on("tool_result", (event) => {
			toolResultHooks.push(event.toolName);
			return undefined;
		});
	};
	return { toolCallHooks, toolResultHooks, factory };
}

export function dispatchedCollector(harness: Harness): ToolDispatchedInfo[] {
	const dispatched: ToolDispatchedInfo[] = [];
	harness.session.toolDispatcher.onDispatched((info) => dispatched.push(info));
	return dispatched;
}
