import type { ToolCallHold } from "./window.ts";
import { isHookedWriteTool, type WrittenFiles } from "./written-files.ts";

type SessionEvent = "tool_call_ready" | "tool_execution_end" | "turn_start";
type OnSessionEvent = (event: SessionEvent, handler: (event: unknown) => unknown) => void;

/** Calls that never report an end must not accumulate. */
const MAX_STARTED_CALLS = 256;

/**
 * Tells the written-files check about the `write` and `edit` calls the model issues itself while a detached cell is
 * still running. The host fires `tool_call_ready` once every `tool_call` handler let the call run, with the arguments
 * it runs with, and finishes its handlers before the call writes anything; it fires `tool_execution_end` after the
 * call's hooks returned. The call holds the file it will write from that point to its end: a cell settling in between
 * neither lists nor hooks it, and the end records what the call left. A call a handler blocked, or redirected, never
 * holds the path it was first given, so it takes nothing from a cell that wrote that path. A call whose end never
 * arrives (thrown before it finished) is let go at the next `turn_start`: a turn starts only once every call of the
 * turn before it has ended.
 */
export function observeModelWrites(on: OnSessionEvent, current: () => WrittenFiles | undefined): void {
	const started = new Map<string, ToolCallHold>();
	const releaseAll = async () => {
		const holds = [...started.values()];
		started.clear();
		await Promise.all(holds.map((hold) => hold.end(false)));
	};
	on("tool_call_ready", async (event) => {
		const toolCallId = stringField(event, "toolCallId");
		const toolName = stringField(event, "toolName");
		if (toolCallId === undefined || toolName === undefined || !isHookedWriteTool(toolName)) return;
		const previous = started.get(toolCallId);
		started.delete(toolCallId);
		await previous?.end(false);
		if (started.size >= MAX_STARTED_CALLS) await releaseAll();
		const hold = await current()?.startToolCall(toolName, field(event, "input"));
		if (hold !== undefined) started.set(toolCallId, hold);
	});
	on("tool_execution_end", async (event) => {
		const toolCallId = stringField(event, "toolCallId");
		const hold = toolCallId === undefined ? undefined : started.get(toolCallId);
		if (toolCallId === undefined || hold === undefined) return;
		started.delete(toolCallId);
		await hold.end(field(event, "isError") !== true);
	});
	on("turn_start", releaseAll);
}

function field(event: unknown, name: string): unknown {
	return typeof event === "object" && event !== null ? Reflect.get(event, name) : undefined;
}

function stringField(event: unknown, name: string): string | undefined {
	const value = field(event, name);
	return typeof value === "string" ? value : undefined;
}
