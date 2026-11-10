/**
 * CK22 tool dispatch and recovery (custody design 15.1(d), 2.9 S8a/S13).
 *
 * Two obligations the hosted driver owes its tools, kept out of `reference-driver.ts`:
 * - the dispatch ledger refuses by generation. A call held across an eviction is refused before the
 *   tool runs, so a tool that ignores its abort signal still produces no effect for a discarded instance;
 * - a committed-but-unrun tool call is recovered through the public tool pipeline, so a resumed call
 *   runs the same `beforeToolCall`/`afterToolCall` hooks (so `tool_call`/`tool_result`) and result
 *   transformation as a live one, under an abort signal a stop can cancel. It is not a full live run: it
 *   emits no `tool_execution_update` and no `turn_start`/`turn_end`, and runs pending calls one at a
 *   time whatever the agent's tool execution mode.
 */
import { type AgentMessage, type AgentTool, type AgentToolCall, runToolCall } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Harness } from "../../suite/harness.ts";

export interface ToolLedgerEntry {
	toolName: string;
	toolCallId: string;
	generation: number;
	outcome: "ran" | "killed";
}

export interface PausedToolCall {
	readonly reached: Promise<void>;
	release(): void;
	kill(): void;
}

export interface ToolDispatchLedger {
	readonly entries: readonly ToolLedgerEntry[];
	/** Wraps every tool so each dispatch is recorded, held when armed, and refused when stale. */
	wrap(tools: readonly AgentTool[] | undefined): AgentTool[] | undefined;
	/** Holds the next dispatch at the tool boundary until it is released or killed. */
	pauseNextTool(): PausedToolCall;
	/** Kills a held call, as an eviction or a stop of the active step does. */
	killHeld(): void;
	/** Whether a dispatch is currently held. */
	hasHeldCall(): boolean;
}

/** A dispatch refused because the instance that issued it is no longer the current one. */
export class StaleDispatchError extends Error {
	readonly toolCallId: string;
	readonly dispatchGeneration: number;

	constructor(toolCallId: string, dispatchGeneration: number) {
		super(`refused tool dispatch ${toolCallId} from discarded generation ${dispatchGeneration}`);
		this.name = "StaleDispatchError";
		this.toolCallId = toolCallId;
		this.dispatchGeneration = dispatchGeneration;
	}
}

type HeldDispatch = { readonly arrive: () => void; readonly gate: Promise<"release" | "kill"> };

export function createToolDispatchLedger(currentGeneration: () => number): ToolDispatchLedger {
	const entries: ToolLedgerEntry[] = [];
	let pendingHold: HeldDispatch | undefined;
	let heldKill: (() => void) | undefined;

	const wrapTool = (tool: AgentTool): AgentTool => ({
		...tool,
		execute: async (toolCallId: string, params: unknown, signal?: AbortSignal, ...rest: unknown[]) => {
			const entry: ToolLedgerEntry = {
				toolName: tool.name,
				toolCallId,
				generation: currentGeneration(),
				outcome: "ran",
			};
			entries.push(entry);
			let callSignal = signal;
			const hold = pendingHold;
			if (hold) {
				pendingHold = undefined;
				hold.arrive();
				if ((await hold.gate) === "kill") {
					const controller = new AbortController();
					controller.abort();
					callSignal = controller.signal;
					entry.outcome = "killed";
				}
			}
			// 15.1(d): dispatch is generation-owned and re-checked after the gate it awaited. Abort
			// cooperation is the tool's choice; containment is not, so a discarded generation never
			// reaches `execute`.
			if (entry.generation !== currentGeneration()) {
				entry.outcome = "killed";
				throw new StaleDispatchError(toolCallId, entry.generation);
			}
			const run = tool.execute as (
				id: string,
				p: unknown,
				s?: AbortSignal,
				...args: unknown[]
			) => ReturnType<typeof tool.execute>;
			return run(toolCallId, params, callSignal, ...rest);
		},
	});

	return {
		entries,
		wrap: (tools) => tools?.map(wrapTool),
		pauseNextTool() {
			let arrive = () => {};
			const reached = new Promise<void>((resolve) => {
				arrive = resolve;
			});
			let decide: (choice: "release" | "kill") => void = () => {};
			const gate = new Promise<"release" | "kill">((resolve) => {
				decide = resolve;
			});
			pendingHold = {
				arrive: () => {
					heldKill = () => decide("kill");
					arrive();
				},
				gate,
			};
			return {
				reached,
				release: () => {
					heldKill = undefined;
					decide("release");
				},
				kill: () => {
					heldKill = undefined;
					decide("kill");
				},
			};
		},
		killHeld() {
			heldKill?.();
			heldKill = undefined;
		},
		hasHeldCall: () => heldKill !== undefined,
	};
}

/** The instance members a recovery run drives; the driver already wraps both (file header). */
interface RecoveringAgent {
	runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void>;
	processEvents(event: unknown): Promise<void>;
}

export interface ToolRecoveryOptions {
	readonly instance: Harness;
	/** The committed assistant message whose tool calls the rebuilt instance inherits. */
	readonly assistantMessage: AssistantMessage;
	/** Tool call ids the exactly-once ledger has already run. */
	readonly alreadyRan: ReadonlySet<string>;
	readonly now: () => number;
	/** Receives each tool result for the durable row the recovered call owes. */
	readonly onResult: (message: AgentMessage) => void;
}

/** How a recovery run ended: `stopped` means a stop aborted it, and the model is owed no continuation. */
export interface ToolRecovery {
	readonly ran: number;
	readonly stopped: boolean;
}

/**
 * Runs the committed step's unrun tool calls on the rebuilt instance.
 *
 * The lifecycle run is what makes this the real pipeline rather than a replay: it owns the abort
 * signal a concurrent stop uses and the active run `processEvents` requires, while `runToolCall`
 * keeps argument preparation, `beforeToolCall`, execution and `afterToolCall` in one order with a
 * live dispatch. The result therefore carries the hooks' own content, `isError` and `details`.
 */
export async function recoverPendingToolCalls(options: ToolRecoveryOptions): Promise<ToolRecovery> {
	const { instance, assistantMessage, alreadyRan, now, onResult } = options;
	const pending = assistantMessage.content.filter(
		(block): block is AgentToolCall => block.type === "toolCall" && !alreadyRan.has(block.id),
	);
	if (pending.length === 0) return { ran: 0, stopped: false };
	const agent = instance.agent;
	const internals = agent as unknown as RecoveringAgent;
	let stopped = false;
	await internals.runWithLifecycle(async (signal) => {
		for (const call of pending) {
			await internals.processEvents({
				type: "tool_execution_start",
				toolCallId: call.id,
				toolName: call.name,
				args: call.arguments,
			});
			const outcome = await runToolCall(call, {
				tools: agent.state.tools,
				assistantMessage,
				context: {
					...(agent.state.systemPrompt === undefined ? {} : { systemPrompt: agent.state.systemPrompt }),
					messages: agent.state.messages.slice(),
					tools: agent.state.tools.slice(),
				},
				...(agent.beforeToolCall ? { beforeToolCall: agent.beforeToolCall } : {}),
				...(agent.afterToolCall ? { afterToolCall: agent.afterToolCall } : {}),
				signal,
			});
			const result: AgentMessage = {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: outcome.result.content,
				isError: outcome.isError,
				timestamp: now(),
				...(outcome.result.details === undefined ? {} : { details: outcome.result.details }),
				...(outcome.result.structuredContent === undefined
					? {}
					: { structuredContent: outcome.result.structuredContent }),
			};
			await internals.processEvents({
				type: "tool_execution_end",
				toolCallId: call.id,
				toolName: call.name,
				result: outcome.result,
				isError: outcome.isError,
			});
			// `message_end` is the seam that puts the result into the instance's own transcript, so the
			// recovered call lands in state exactly where a live one does.
			await internals.processEvents({ type: "message_start", message: result });
			await internals.processEvents({ type: "message_end", message: result });
			onResult(result);
		}
		stopped = signal.aborted;
	});
	return { ran: pending.length, stopped };
}
