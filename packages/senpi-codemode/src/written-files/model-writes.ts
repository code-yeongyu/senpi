import { isHookedWriteTool, type WrittenFiles } from "./written-files.ts";

type SessionEvent = "tool_execution_start" | "tool_execution_end";
type OnSessionEvent = (event: SessionEvent, handler: (event: unknown) => unknown) => void;

/** Calls that never report an end must not accumulate. */
const MAX_STARTED_CALLS = 256;

/**
 * Tells the written-files check about the `write` and `edit` calls the model issues itself while a detached cell is
 * still running: those files went through the hooks, so the cell does not claim them. `tool_execution_end` fires after
 * the call's hooks and carries no arguments, so the start event's arguments are kept until it arrives.
 */
export function observeModelWrites(on: OnSessionEvent, current: () => WrittenFiles | undefined): void {
	const started = new Map<string, { readonly toolName: string; readonly args: unknown }>();
	on("tool_execution_start", (event) => {
		const toolCallId = stringField(event, "toolCallId");
		const toolName = stringField(event, "toolName");
		if (toolCallId === undefined || toolName === undefined || !isHookedWriteTool(toolName)) return;
		if (started.size >= MAX_STARTED_CALLS) started.clear();
		started.set(toolCallId, { toolName, args: field(event, "args") });
	});
	on("tool_execution_end", async (event) => {
		const toolCallId = stringField(event, "toolCallId");
		const call = toolCallId === undefined ? undefined : started.get(toolCallId);
		if (toolCallId === undefined || call === undefined) return;
		started.delete(toolCallId);
		if (field(event, "isError") !== true) await current()?.noteToolCall(call.toolName, call.args);
	});
}

function field(event: unknown, name: string): unknown {
	return typeof event === "object" && event !== null ? Reflect.get(event, name) : undefined;
}

function stringField(event: unknown, name: string): string | undefined {
	const value = field(event, name);
	return typeof value === "string" ? value : undefined;
}
