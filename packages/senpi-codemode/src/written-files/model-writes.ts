import type { ToolCallHold } from "./window.ts";
import { isHookedWriteTool, type WrittenFiles } from "./written-files.ts";

type SessionEvent = "tool_execution_start" | "tool_call_ready" | "tool_execution_end" | "turn_start";
type OnSessionEvent = (event: SessionEvent, handler: (event: unknown) => unknown) => void;

/** Calls that never report an end must not accumulate. */
const MAX_STARTED_CALLS = 256;

/**
 * Tells the written-files check about the `write` and `edit` calls the model issues itself while a detached cell is
 * still running. The host finishes `tool_execution_start` handlers before the call runs and fires `tool_execution_end`
 * after the call's hooks returned, so the call holds its file from its start to its end: a cell settling in between
 * neither lists nor hooks it, and the end records what the call left. A `tool_call` handler may redirect the call to
 * another path: `tool_call_ready` carries the arguments the call runs with, before it runs, and the hold moves to that
 * path, taken before the requested one is let go, so the file the call writes is the one held and recorded. A call
 * whose end never arrives (refused or thrown before it finished) is let go at the next `turn_start`: a turn starts
 * only once every call of the turn before it has ended.
 */
export function observeModelWrites(on: OnSessionEvent, current: () => WrittenFiles | undefined): void {
	const started = new Map<string, ToolCallHold>();
	const releaseAll = async () => {
		const holds = [...started.values()];
		started.clear();
		await Promise.all(holds.map((hold) => hold.end(false)));
	};
	on("tool_execution_start", async (event) => {
		const toolCallId = stringField(event, "toolCallId");
		const toolName = stringField(event, "toolName");
		if (toolCallId === undefined || toolName === undefined || !isHookedWriteTool(toolName)) return;
		await started.get(toolCallId)?.end(false);
		if (started.size >= MAX_STARTED_CALLS) await releaseAll();
		const hold = current()?.startToolCall(toolName, field(event, "args"));
		if (hold !== undefined) started.set(toolCallId, hold);
	});
	on("tool_call_ready", async (event) => {
		const toolCallId = stringField(event, "toolCallId");
		const toolName = stringField(event, "toolName");
		const requested = toolCallId === undefined ? undefined : started.get(toolCallId);
		if (toolCallId === undefined || toolName === undefined || requested === undefined) return;
		const effective = current()?.startToolCall(toolName, field(event, "input"));
		if (effective === undefined) started.delete(toolCallId);
		else started.set(toolCallId, effective);
		await requested.end(false);
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
