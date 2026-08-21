import { convertToLlm, filterContextExcludedMessages } from "../../../messages.ts";
import { buildSessionContext } from "../../../session-manager.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../types.ts";
import { formatBtwQuestion, sanitizeBtwDisplayText } from "./display-text.ts";
import { BTW_HISTORY_ENTRY_TYPE, buildBtwHistoryMessages, readBtwHistory } from "./history.ts";
import { buildSideQueryContext, getSideQueryPromptContextWindow, runSideQuery } from "./side-query.ts";

export type SideCommandName = "btw" | "side";

export interface NonTuiSideState {
	request: AbortController | undefined;
}

export function abortNonTuiSide(state: NonTuiSideState): void {
	state.request?.abort(new Error("BTW side question closed"));
	state.request = undefined;
}

export async function runNonTuiSideCommand(
	pi: ExtensionAPI,
	commandName: SideCommandName,
	question: string,
	ctx: ExtensionCommandContext,
	state: NonTuiSideState,
): Promise<void> {
	if (question.length === 0) {
		showHistory(ctx);
		return;
	}
	const model = ctx.model;
	if (model === undefined) {
		ctx.ui.notify(`No active model available for /${commandName}.`, "error");
		return;
	}
	state.request?.abort(new Error("Superseded by a newer side question"));
	const request = new AbortController();
	state.request = request;
	const snapshot = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		if (state.request !== request) return;
		state.request = undefined;
		ctx.ui.notify(`/${commandName}: ${sanitizeBtwDisplayText(auth.error)}`, "error");
		return;
	}
	try {
		const context = buildSideQueryContext({
			systemPrompt: ctx.getSystemPrompt(),
			history: convertToLlm(filterContextExcludedMessages(snapshot.messages)),
			priorBtw: buildBtwHistoryMessages(readBtwHistory(ctx.sessionManager.getBranch()), model),
			question,
			promptContextWindow: getSideQueryPromptContextWindow(model),
		});
		const result = await runSideQuery(
			{
				model,
				auth: { apiKey: auth.apiKey, headers: auth.headers, extraBody: auth.extraBody },
				sessionId: ctx.sessionManager.getSessionId(),
				thinkingLevel: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
				streamFn: (streamModel, streamContext, streamOptions) =>
					ctx.modelRegistry.modelRuntime.streamSimple(streamModel, streamContext, streamOptions),
			},
			context,
			{ signal: request.signal },
		);
		if (state.request !== request) return;
		pi.appendEntry(BTW_HISTORY_ENTRY_TYPE, { question, answer: result.replyText, timestamp: Date.now() });
		ctx.ui.notify(sanitizeBtwDisplayText(result.replyText), "info");
	} catch (error) {
		if (state.request !== request || request.signal.aborted) return;
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`/${commandName} failed: ${sanitizeBtwDisplayText(message)}`, "error");
	} finally {
		if (state.request === request) state.request = undefined;
	}
}

function showHistory(ctx: ExtensionCommandContext): void {
	const entries = readBtwHistory(ctx.sessionManager.getBranch());
	if (entries.length === 0) {
		ctx.ui.notify("No side questions yet in this session.", "info");
		return;
	}
	ctx.ui.notify(
		entries
			.map(
				(entry, index) =>
					`${index + 1}. Question: ${formatBtwQuestion(entry.question)}\nAnswer: ${sanitizeBtwDisplayText(entry.answer)}`,
			)
			.join("\n\n"),
		"info",
	);
}
