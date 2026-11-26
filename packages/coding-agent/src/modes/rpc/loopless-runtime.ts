import type { AgentToolResult, NestedRequest } from "@earendil-works/pi-agent-core";
import type { AgentSessionLaunchProfile } from "../../core/agent-session-runtime.ts";
import type { AgentSessionRuntimeDiagnostic } from "../../core/agent-session-services.ts";
import type { HandWake } from "../../core/execution/hand-wake-route.ts";
import type { ToolDefinitionEntry } from "../../core/runtime/bootstrap.ts";
import type { HandFileGuards } from "./hand-file-ops.ts";
import type { LooplessCallFacts } from "./loopless-brain-calls.ts";
import type { LooplessLoopHooks } from "./loopless-loop-hooks.ts";

/**
 * A session worker's runtime with the agent loop removed (brain/hand split, senpi#5413): the same
 * built-in and extension tools a full session serves, executed one call at a time, with no agent loop,
 * no model binding and no transcript. Its extension runtime is never bound to a loop, so an extension
 * that tries to drive one (`pi.sendUserMessage`, `pi.setModel`, ...) is refused.
 */
export interface LooplessRuntime {
	readonly cwd: string;
	/** Every tool this runtime serves: built-ins first, then extension tools, a later name replacing an earlier one. */
	readonly definitions: ReadonlyMap<string, ToolDefinitionEntry>;
	/** What building the runtime reported: settings, extension load and `project_trust` handler diagnostics. */
	readonly diagnostics: readonly AgentSessionRuntimeDiagnostic[];
	/**
	 * Runs one tool call: argument preparation and schema validation as the loop does, then the tool. An unknown
	 * name is refused before anything runs; invalid arguments and a failing tool come back as an `isError` result.
	 *
	 * A runtime refuses every call unless it was built with a grant from the closed allowlist in
	 * `loopless-execute-grant.ts`. With the remote tool executor's grant every call runs this runtime's extensions'
	 * `tool_call` handlers (permission checks among them; a block or a throw stops the call) and `tool_result`
	 * handlers; the in-process test harness's grant runs the tool alone.
	 */
	execute(
		name: string,
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		nested?: NestedRequest,
		facts?: LooplessCallFacts,
	): Promise<AgentToolResult<unknown>>;
	/**
	 * Runs this runtime's extensions' loop hooks for a loop that runs elsewhere, on the same runner as its tool calls
	 * (S33). Refused unless the runtime was built as its extensions' home (`twoSidedHome: "hand"`). `describe_tools`
	 * (the tool list a local session here would show its model, senpi#6749) is answered on any runtime.
	 */
	readonly runLoopHooks: LooplessLoopHooks;
	/**
	 * What a device file operation (S40) is checked against: this runtime's `tool_call` handlers and filesystem policy.
	 * Present only when its grant runs the handlers, so no file operation can skip them.
	 */
	readonly fileGuards: HandFileGuards | undefined;
	/** Marks its extension contexts stale, then closes the tool work and the tool child it still runs. */
	dispose(): Promise<void>;
}

export interface LooplessRuntimeProfile {
	cwd: string;
	launchProfile?: Readonly<AgentSessionLaunchProfile>;
	/**
	 * On a hand, this runtime's scope's wake outbox (H3): what its work sends to the loop after the call that started it
	 * ended (messages, user messages, notices) goes there. Absent, that work stays loop-side and unbound.
	 */
	wake?: (wake: HandWake) => void;
}

export type LooplessRuntimeFactory = (profile: LooplessRuntimeProfile) => Promise<LooplessRuntime>;

export class LooplessToolNotFoundError extends Error {
	readonly toolName: string;
	constructor(toolName: string) {
		super(`loopless_tool_not_found: ${toolName}`);
		this.toolName = toolName;
	}
}
