// Turn-end backstop for main sessions without an active goal: a text-only end of turn
// while the todo list still has open tasks gets one hidden nudge (two per chain at most).
// Anthropic's Opus 5.5 guide, "Unattended agentic runs": "If a turn ends with items still
// open and no blocker stated, send a short user message naming them" and "stop after two
// or three automatic continuations on the same task rather than repeating them indefinitely".

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createSessionLogger, type SessionLogger } from "../../../session-log.ts";
import { SettingsManager } from "../../../settings-manager.ts";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext, ExtensionMode } from "../../types.ts";
import { TOOL_NAMES as ASK_USER_TOOL_NAMES } from "../ask-user/family.ts";
import { describeAskNowNext, getLatestTodoStateFromBranchEntries } from "../todotools/state.ts";
import { didAgentEndCleanly } from "./continuation.ts";
import { lastAssistantMessage } from "./last-assistant-message.ts";
import { openTodoTaskContents } from "./todo-gate.ts";
import type { Goal } from "./types.ts";

export const TODO_OWED_CUSTOM_TYPE = "senpi.todo-owed";
export const TODO_OWED_REMINDER_EVENT = "todo_owed_reminder";
export const TODO_OWED_CHAIN_LIMIT = 2;
export const TODO_OWED_SECOND_PREFIX = "Second and final reminder. ";

/** One-shot, non-interactive runs; the same set `terminal/notify.ts` never wakes. */
const NON_INTERACTIVE_MODES: ReadonlySet<ExtensionMode> = new Set(["print", "json"]);
const ASK_USER_TOOLS: ReadonlySet<string> = new Set(Object.values(ASK_USER_TOOL_NAMES));
// A `?` that ends a sentence: followed by optional closing quotes/brackets/emphasis, then whitespace or the end.
const QUESTION_SENTENCE_END = /[?\uFF1F]["'`*_)\]}\u2019\u201D]*(?:\s|$)/u;

export type TodoOwedSuppression =
	| "disabled"
	| "subagent"
	| "non-interactive"
	| "not-clean"
	| "length"
	| "pending-messages"
	| "active-goal"
	| "continuation-pending"
	| "no-open-tasks"
	| "wake-source"
	| "ask-user-call"
	| "question"
	| "cap";

export type TodoOwedReminderEvent = {
	sessionId: string;
	chainCount: number;
	openTasks: number;
	now: string;
	next: string;
	reason: "delivered" | "capped";
};

export type TodoOwedInput = {
	readonly ctx: ExtensionContext;
	readonly event: AgentEndEvent;
	readonly goal: Goal | null;
	readonly continuationPending: boolean;
	readonly hasActiveWakeSources: boolean;
};

export function buildTodoOwedReminder(anchors: { ask: string; now: string; next: string }, final: boolean): string {
	const prefix = final ? TODO_OWED_SECOND_PREFIX : "";
	return `<system-reminder>
${prefix}The turn ended with open todo work and no question to the user. Ask: ${anchors.ask}. Now: ${anchors.now}. Next: ${anchors.next}. Either continue the next open task now with real tool calls, or mark it done/dropped via the todo tool and tell the user in one sentence why you stopped. Do not restate the plan.
</system-reminder>`;
}

/** True when the last non-empty paragraph of the text ends any sentence with `?`. */
export function endsWithQuestion(text: string): boolean {
	const paragraphs = text
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph !== "");
	const last = paragraphs.at(-1);
	return last !== undefined && QUESTION_SENTENCE_END.test(last);
}

function assistantText(message: Extract<AgentMessage, { role: "assistant" }> | undefined): string {
	if (message === undefined) return "";
	return message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

function calledAskUser(messages: readonly AgentMessage[]): boolean {
	return messages.some(
		(message) =>
			message.role === "assistant" &&
			message.content.some((content) => content.type === "toolCall" && ASK_USER_TOOLS.has(content.name)),
	);
}

function readTurnEndBackstopSetting(ctx: ExtensionContext): boolean {
	return SettingsManager.create(ctx.cwd, ctx.agentDir, {
		projectTrusted: ctx.isProjectTrusted(),
	}).getTodoTurnEndBackstop();
}

/**
 * The first clause that makes the ended turn NOT owe a nudge, or undefined when every
 * clause holds except the per-chain cap. Child sessions are untagged today (their header
 * carries no `parentSession`), so they pass the main-session clause and are treated as main.
 */
export function firstTodoOwedSuppression(input: TodoOwedInput): Exclude<TodoOwedSuppression, "cap"> | undefined {
	const { ctx, event, goal } = input;
	// Optional call: session managers that predate `getHeader` (and the goal test
	// harness fakes) expose no parent tag, which reads as "main session" - the same
	// treatment untagged child sessions get today.
	if (ctx.sessionManager.getHeader?.()?.parentSession !== undefined) return "subagent";
	if (NON_INTERACTIVE_MODES.has(ctx.mode)) return "non-interactive";
	if (event.aborted === true || !didAgentEndCleanly(event.messages)) return "not-clean";
	if (lastAssistantMessage(event.messages)?.stopReason === "length") return "length";
	if (ctx.hasPendingMessages()) return "pending-messages";
	if (goal?.status === "active") return "active-goal";
	if (input.continuationPending) return "continuation-pending";
	if (openTodoTaskContents(ctx.sessionManager.getBranch()).length === 0) return "no-open-tasks";
	if (input.hasActiveWakeSources) return "wake-source";
	if (calledAskUser(event.messages)) return "ask-user-call";
	if (endsWithQuestion(assistantText(lastAssistantMessage(event.messages)))) return "question";
	if (!readTurnEndBackstopSetting(ctx)) return "disabled";
	return undefined;
}

/**
 * Per-session chain state. The chain counts nudges since the last accepted direct user
 * input (or `session_start` / `session_tree`); after two deliveries the third owed turn
 * notifies the user once and every later one stays silent until the chain resets.
 */
export class TodoOwedBackstop {
	readonly #pi: ExtensionAPI;
	#remindersThisChain = 0;
	#notifiedThisChain = false;
	#logger: SessionLogger | undefined;

	constructor(pi: ExtensionAPI) {
		this.#pi = pi;
	}

	resetChain(): void {
		this.#remindersThisChain = 0;
		this.#notifiedThisChain = false;
	}

	afterAgentEnd(input: TodoOwedInput): void {
		const suppression = firstTodoOwedSuppression(input);
		if (suppression !== undefined) {
			this.#logSuppression(input.ctx, suppression);
			return;
		}
		const { ctx } = input;
		const branch = ctx.sessionManager.getBranch();
		const openTasks = openTodoTaskContents(branch).length;
		const anchors = describeAskNowNext(getLatestTodoStateFromBranchEntries(branch));
		const sessionId = ctx.sessionManager.getSessionId();
		if (this.#remindersThisChain >= TODO_OWED_CHAIN_LIMIT) {
			if (this.#notifiedThisChain) {
				this.#logSuppression(ctx, "cap");
				return;
			}
			this.#notifiedThisChain = true;
			ctx.ui.notify(
				`Agent stopped with ${openTasks} open todo tasks (Now: ${anchors.now}). Send a message to continue.`,
				"warning",
			);
			this.#emit({
				sessionId,
				chainCount: this.#remindersThisChain,
				openTasks,
				now: anchors.now,
				next: anchors.next,
				reason: "capped",
			});
			return;
		}
		this.#remindersThisChain += 1;
		const content = buildTodoOwedReminder(anchors, this.#remindersThisChain === TODO_OWED_CHAIN_LIMIT);
		this.#pi.sendMessage(
			{ customType: TODO_OWED_CUSTOM_TYPE, content, display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		this.#emit({
			sessionId,
			chainCount: this.#remindersThisChain,
			openTasks,
			now: anchors.now,
			next: anchors.next,
			reason: "delivered",
		});
	}

	#emit(event: TodoOwedReminderEvent): void {
		this.#pi.events.emit(TODO_OWED_REMINDER_EVENT, event);
	}

	#logSuppression(ctx: ExtensionContext, reason: TodoOwedSuppression): void {
		this.#logger ??= createSessionLogger(ctx.agentDir);
		this.#logger.debug("todo_owed_backstop_suppressed", { reason });
	}
}
