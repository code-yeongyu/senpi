// senpi#3574 review: a dispatch observer is diagnostics only. One that throws must not fail or alter the tool call, must
// not stop later observers, and must be reported through the session's notify sink on BOTH runtimes.
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ToolRuntimeKind } from "../../cli/tool-runtime.ts";
import type { ExtensionToolContext, ToolDefinition } from "../extensions/types.ts";
import { createToolDispatcher, type ToolDispatchedInfo } from "./tool-dispatcher.ts";

const context = {} as ExtensionToolContext;

const definition: ToolDefinition = {
	name: "probe",
	label: "probe",
	description: "probe",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "ran" }], details: { ok: true } }),
};

describe.each<ToolRuntimeKind>(["in-process", "child"])("a throwing dispatch observer (%s runtime)", (runtime) => {
	it("leaves the tool result intact, still runs later observers, and reports the failure once", async () => {
		const notices: Array<{ event: string; data?: Record<string, unknown> }> = [];
		const dispatcher = createToolDispatcher({ runtime, notify: (event, data) => notices.push({ event, data }) });
		const seen: ToolDispatchedInfo[] = [];
		dispatcher.onDispatched(() => {
			throw new Error("observer exploded");
		});
		dispatcher.onDispatched((info) => seen.push(info));

		const result = await dispatcher.run({ definition, toolCallId: "call-1", params: {}, ctx: context });

		expect(result).toEqual({ content: [{ type: "text", text: "ran" }], details: { ok: true } });
		expect(seen.map((info) => [info.toolCallId, info.placement])).toEqual([["call-1", "server"]]);
		expect(notices).toEqual([{ event: "tool_dispatch_observer_failed", data: { message: "observer exploded" } }]);
	});
});
