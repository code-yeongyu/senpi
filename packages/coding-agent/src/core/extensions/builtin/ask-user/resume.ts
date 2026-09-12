import type { SessionEntry } from "../../../session-manager.ts";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../../types.ts";
import { TOOL_NAMES } from "./family.ts";
import { formatUserMessage } from "./format.ts";
import {
	type AskUserVariant,
	DEFAULT_ASK_USER_TIMEOUT_MS,
	type QuestionRequest,
	type QuestionResponse,
	toCanonical,
} from "./schema.ts";

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

function findDanglingQuestion(entries: readonly SessionEntry[]): DanglingQuestion | undefined {
	const results = new Set<string>();
	const resumed = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === ASK_USER_RESUMED_ENTRY && isRecord(entry.data)) {
			const toolCallId = entry.data.toolCallId;
			if (typeof toolCallId === "string") resumed.add(toolCallId);
		}
		if (entry.type === "message" && entry.message.role === "toolResult") {
			results.add(entry.message.toolCallId);
		}
	}
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		const content = entry.message.content;
		for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex--) {
			const block = content[blockIndex];
			if (block?.type !== "toolCall" || block.incomplete === true) continue;
			const variant = variantFor(block.name);
			if (!variant || results.has(block.id) || resumed.has(block.id)) continue;
			return { toolCallId: block.id, variant, args: block.arguments };
		}
	}
	return undefined;
}

function requestFromCall(dangling: DanglingQuestion, timeoutMs: number): QuestionRequest {
	try {
		return toCanonical(dangling.variant, dangling.args, { requestId: dangling.toolCallId, timeoutMs });
	} catch {
		return { requestId: dangling.toolCallId, questions: [], waitForAnswer: false, timeoutMs };
	}
}

function orphaned(request: QuestionRequest): QuestionResponse {
	return {
		status: "orphaned-after-restart",
		answers: {},
		unanswered: request.questions.map((question) => question.id),
	};
}

function deliver(
	pi: Pick<ExtensionAPI, "sendUserMessage">,
	request: QuestionRequest,
	response: QuestionResponse,
): void {
	pi.sendUserMessage(formatUserMessage(response, request.requestId, request.questions));
}

export async function resumeDanglingQuestion(
	pi: Pick<ExtensionAPI, "appendEntry" | "sendUserMessage">,
	event: Pick<SessionStartEvent, "reason">,
	ctx: Pick<ExtensionContext, "sessionManager" | "ui" | "getAskUserSettings">,
): Promise<void> {
	if (event.reason !== "resume" && event.reason !== "reload") return;
	const dangling = findDanglingQuestion(ctx.sessionManager.getBranch());
	if (!dangling) return;
	pi.appendEntry(ASK_USER_RESUMED_ENTRY, { toolCallId: dangling.toolCallId });
	const timeoutMs = (ctx.getAskUserSettings?.().timeoutMinutes ?? DEFAULT_ASK_USER_TIMEOUT_MS / 60_000) * 60_000;
	const request = requestFromCall(dangling, timeoutMs);
	const question = ctx.ui.question;
	if (!question) {
		deliver(pi, request, orphaned(request));
		return;
	}
	try {
		const response = await question.call(ctx.ui, request, { timeout: request.timeoutMs });
		deliver(pi, request, response);
	} catch {
		deliver(pi, request, orphaned(request));
	}
}
