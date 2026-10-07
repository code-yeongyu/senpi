import type { SessionEntry } from "../../../session-manager.ts";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../../types.ts";
import { TOOL_NAMES } from "./family.ts";
import { parseAskUserAnswerFrame } from "./format.ts";
import { ASK_USER_SETTLEMENT_ENTRY, emitAskUserClosed } from "./notify.ts";
import { getPendingQuestions } from "./registry.ts";
import {
	type AskUserVariant,
	DEFAULT_ASK_USER_TIMEOUT_MS,
	type QuestionRequest,
	type QuestionResponse,
	toCanonical,
} from "./schema.ts";
import { deliverAnswer, startQuestion } from "./tool.ts";

export const ASK_USER_RESUMED_ENTRY = "ask-user:resumed";

type DanglingQuestion = {
	toolCallId: string;
	variant: AskUserVariant;
	args: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function variantFor(name: string): AskUserVariant | undefined {
	if (name === TOOL_NAMES.claude) return "claude";
	if (name === TOOL_NAMES.codex) return "codex";
	return undefined;
}

function findDanglingQuestions(entries: readonly SessionEntry[]): DanglingQuestion[] {
	const results = new Set<string>();
	const accepted = new Set<string>();
	const resumed = new Set<string>();
	const settled = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "user") {
			const content = entry.message.content;
			const texts =
				typeof content === "string"
					? [content]
					: content.flatMap((part) => (part.type === "text" ? [part.text] : []));
			for (const text of texts) {
				const frame = parseAskUserAnswerFrame(text);
				if (frame) settled.add(frame.requestId);
			}
		}
		if (entry.type === "custom" && entry.customType === ASK_USER_RESUMED_ENTRY && isRecord(entry.data)) {
			const toolCallId = entry.data.toolCallId;
			if (typeof toolCallId === "string") resumed.add(toolCallId);
		}
		if (entry.type === "message" && entry.message.role === "toolResult") {
			results.add(entry.message.toolCallId);
			const details = entry.message.details;
			if (!entry.message.isError && isRecord(details) && details.accepted === true && details.status === "pending") {
				accepted.add(entry.message.toolCallId);
			}
		}
		if (
			entry.type === "custom" &&
			entry.customType === ASK_USER_SETTLEMENT_ENTRY &&
			isRecord(entry.data) &&
			typeof entry.data.requestId === "string"
		)
			settled.add(entry.data.requestId);
	}
	const dangling: DanglingQuestion[] = [];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		const content = entry.message.content;
		for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex--) {
			const block = content[blockIndex];
			if (block?.type !== "toolCall" || block.incomplete === true) continue;
			const variant = variantFor(block.name);
			if (!variant || settled.has(block.id)) continue;
			const call = { toolCallId: block.id, variant, args: block.arguments };
			const request = requestFromCall(call, DEFAULT_ASK_USER_TIMEOUT_MS);
			if (results.has(block.id) && (request?.waitForAnswer === true || !accepted.has(block.id))) continue;
			if (resumed.has(block.id)) continue;
			dangling.push(call);
		}
	}
	return dangling;
}

/** The restorable request, or undefined when the recorded arguments no longer form a valid question set. */
function requestFromCall(dangling: DanglingQuestion, timeoutMs: number): QuestionRequest | undefined {
	try {
		return toCanonical(dangling.variant, dangling.args, {
			requestId: dangling.toolCallId,
			timeoutMs,
		});
	} catch {
		return undefined;
	}
}

/**
 * A call that cannot be restored never reaches the UI: it settles as
 * orphaned-after-restart, like a restored question whose UI is gone, so the
 * model learns it was lost and can ask again.
 */
function settleUnrestorable(
	pi: Pick<ExtensionAPI, "appendEntry" | "sendUserMessage" | "events">,
	ctx: ExtensionContext,
	dangling: DanglingQuestion,
	timeoutMs: number,
): void {
	const lost: QuestionRequest = { requestId: dangling.toolCallId, questions: [], waitForAnswer: false, timeoutMs };
	const response: QuestionResponse = { status: "orphaned-after-restart", answers: {}, unanswered: [] };
	pi.appendEntry(ASK_USER_SETTLEMENT_ENTRY, { requestId: lost.requestId, status: response.status });
	emitAskUserClosed(pi, lost.requestId, response);
	deliverAnswer(pi, ctx, lost, response, dangling.variant);
}

export async function resumeDanglingQuestion(
	pi: Pick<ExtensionAPI, "appendEntry" | "sendUserMessage" | "events">,
	event: Pick<SessionStartEvent, "reason">,
	ctx: ExtensionContext,
): Promise<void> {
	if (event.reason !== "resume" && event.reason !== "reload") return;
	const pending = new Set(
		getPendingQuestions(ctx.sessionManager.getSessionId()).map((entry) => entry.request.requestId),
	);
	const timeoutMs = (ctx.getAskUserSettings?.().timeoutMinutes ?? DEFAULT_ASK_USER_TIMEOUT_MS / 60_000) * 60_000;
	for (const dangling of findDanglingQuestions(ctx.sessionManager.getBranch())) {
		if (pending.has(dangling.toolCallId)) continue;
		pending.add(dangling.toolCallId);
		pi.appendEntry(ASK_USER_RESUMED_ENTRY, { toolCallId: dangling.toolCallId });
		const request = requestFromCall(dangling, timeoutMs);
		if (!request) {
			settleUnrestorable(pi, ctx, dangling, timeoutMs);
			continue;
		}
		// The runtime registration owns delivery, including after another reload.
		void startQuestion(pi, ctx, request, ctx.signal, { timedOut: false, unavailable: false }, dangling.variant, {
			resuming: true,
		});
	}
}
