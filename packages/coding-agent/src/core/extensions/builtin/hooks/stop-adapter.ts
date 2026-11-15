import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { HistoryReducer } from "../../../session-history-reduce.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { diagnostic } from "./diagnostics.ts";
import type { HookDispatchResult, HookDispatchSummary } from "./dispatcher.ts";
import { safeDiagnosticDetails } from "./prompt-adapter.ts";
import { type StopOutputRecord, stopOutputRecords, unsupportedStopOutputDiagnostics } from "./stop-output.ts";
import type { HookDiagnostic, HookInputWire } from "./types.ts";

export const STOP_STATE_CUSTOM_TYPE = "senpi.hooks.stop-state";
export const STOP_DIAGNOSTICS_CUSTOM_TYPE = "senpi.hooks.stop-diagnostics";
export const STOP_OUTPUT_CUSTOM_TYPE = "senpi.hooks.stop-output";

const STOP_REENTRY_LIMIT = 8;

type StopState = {
	readonly sessionId: string;
	readonly turnKey: string;
	readonly count: number;
};

type StopRuntime = Pick<ExtensionAPI, "appendEntry" | "sendUserMessage">;

/** The session and turn a Stop reports, read when the turn ended. */
export type StopTurn = {
	readonly sessionId: string;
	readonly turnKey: string;
};

export function buildStopHookInput(
	event: { readonly messages: readonly AgentMessage[] },
	ctx: ExtensionContext,
): HookInputWire {
	const transcriptPath = ctx.sessionManager.getSessionFile();
	const stopReason = findLastAssistantStopReason(event.messages);
	return {
		cwd: ctx.cwd,
		event: "Stop",
		hook_event_name: "Stop",
		session_id: ctx.sessionManager.getSessionId(),
		...(stopReason === undefined ? {} : { stopReason }),
		...(transcriptPath === undefined ? {} : { transcript_path: transcriptPath }),
	};
}

export function createStopTurnTracker(): {
	readonly reset: () => void;
	readonly turnKey: (ctx: ExtensionContext) => string;
} {
	let activeTurnKey: string | undefined;
	let turnIndex = 0;
	return {
		reset() {
			turnIndex += 1;
			activeTurnKey = undefined;
		},
		turnKey(ctx) {
			if (activeTurnKey !== undefined) return activeTurnKey;
			const leafId = ctx.sessionManager.getLeafId() ?? ctx.sessionManager.getSessionId();
			activeTurnKey = `${turnIndex}:${leafId}`;
			return activeTurnKey;
		},
	};
}

export function applyStopHookResult(
	pi: StopRuntime,
	ctx: ExtensionContext,
	result: HookDispatchResult,
	{ sessionId, turnKey }: StopTurn,
): Promise<void> {
	const previous = latestStopState(ctx, sessionId, turnKey);
	if (previous.count >= STOP_REENTRY_LIMIT) {
		appendStopState(pi, { count: previous.count, sessionId, turnKey });
		appendStopDiagnostics(pi, [
			diagnostic(
				{
					code: "unsupported_event",
					event: "Stop",
					message: "Stop hook reentry limit reached.",
					path: "hooks.Stop",
					severity: "warning",
				},
				limitDiagnosticSource(result),
			),
		]);
		return Promise.resolve();
	}

	const unsupportedDiagnostics = unsupportedStopOutputDiagnostics(result);
	if (unsupportedDiagnostics.length > 0 || result.diagnostics.length > 0) {
		appendStopDiagnostics(pi, [...result.diagnostics, ...unsupportedDiagnostics]);
	}
	appendStopOutputs(pi, stopOutputRecords(result));

	if (result.decision.kind !== "block") {
		appendStopState(pi, { count: previous.count, sessionId, turnKey });
		return Promise.resolve();
	}

	const count = previous.count + 1;
	appendStopState(pi, { count, sessionId, turnKey });
	const followUp = stopFollowUpText(result);
	if (followUp === undefined) {
		appendStopDiagnostics(pi, [
			diagnostic(
				{
					code: "unsupported_field",
					event: "Stop",
					message: "Stop hook blocked without follow-up context.",
					path: "stdout.reason",
					severity: "warning",
				},
				result.decision.source,
			),
		]);
		return Promise.resolve();
	}
	pi.sendUserMessage(followUp, { deliverAs: "followUp" });
	return waitForFollowUpQueue(ctx);
}

async function waitForFollowUpQueue(ctx: ExtensionContext): Promise<void> {
	for (let attempt = 0; attempt < 64; attempt += 1) {
		await Promise.resolve();
		if (ctx.hasPendingMessages()) return;
	}
}

/** The latest valid stop state per session and turn, folded without a full-history view: Stop runs every turn (senpi#2537). */
const latestStopStates: HistoryReducer<Map<string, StopState>> = {
	initial: () => new Map(),
	add: (states, entry) => {
		if (entry.type === "custom" && entry.customType === STOP_STATE_CUSTOM_TYPE && isStopState(entry.data)) {
			states.set(stopStateKey(entry.data.sessionId, entry.data.turnKey), entry.data);
		}
		return states;
	},
};

function stopStateKey(sessionId: string, turnKey: string): string {
	return `${sessionId}\u0000${turnKey}`;
}

function latestStopState(ctx: ExtensionContext, sessionId: string, turnKey: string): StopState {
	return (
		ctx.sessionManager.reduceHistory(latestStopStates).get(stopStateKey(sessionId, turnKey)) ?? {
			count: 0,
			sessionId,
			turnKey,
		}
	);
}

function appendStopState(pi: StopRuntime, state: StopState): void {
	pi.appendEntry(STOP_STATE_CUSTOM_TYPE, state);
}

function appendStopDiagnostics(pi: StopRuntime, diagnostics: readonly HookDiagnostic[]): void {
	if (diagnostics.length === 0) return;
	pi.appendEntry(STOP_DIAGNOSTICS_CUSTOM_TYPE, diagnostics.map(safeStopDiagnosticDetails));
}

function safeStopDiagnosticDetails(diagnostic: HookDiagnostic): ReturnType<typeof safeDiagnosticDetails> {
	if (
		diagnostic.code === "invalid_event_config" &&
		diagnostic.event === "Stop" &&
		diagnostic.path === "stdout.hookSpecificOutput.hookEventName"
	) {
		return {
			...safeDiagnosticDetails(diagnostic),
			message: "Hook output event does not match Stop.",
		};
	}
	return safeDiagnosticDetails(diagnostic);
}

function appendStopOutputs(pi: StopRuntime, records: readonly StopOutputRecord[]): void {
	if (records.length === 0) return;
	pi.appendEntry(STOP_OUTPUT_CUSTOM_TYPE, records);
}

function stopFollowUpText(result: HookDispatchResult): string | undefined {
	if (result.decision.kind !== "block") return undefined;
	const blocker = blockingSummary(result);
	if (blocker === undefined || blocker.run.exitCode === 2) return undefined;
	return blocker.output.additionalContext ?? result.decision.reason;
}

function blockingSummary(result: HookDispatchResult): HookDispatchSummary | undefined {
	if (result.decision.kind !== "block") return undefined;
	const sourcePath = result.decision.source.sourcePath;
	return result.summaries.find(
		(summary) =>
			summary.handler.source.sourcePath === sourcePath &&
			(summary.output.decision === "block" || summary.output.decision === "deny"),
	);
}

function limitDiagnosticSource(result: HookDispatchResult): HookDiagnostic["source"] {
	return (
		result.matchedHandlers[0]?.source ??
		result.executableHandlers[0]?.source ?? {
			discoveredAt: "runtime",
			displayOrder: 0,
			scope: "managed",
			sourcePath: "<builtin:hooks>",
		}
	);
}

function isStopState(value: unknown): value is StopState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	if (!("sessionId" in value) || !("turnKey" in value) || !("count" in value)) return false;
	return (
		typeof value.sessionId === "string" &&
		typeof value.turnKey === "string" &&
		typeof value.count === "number" &&
		Number.isInteger(value.count) &&
		value.count >= 0
	);
}

function findLastAssistantStopReason(messages: readonly AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "assistant") return message.stopReason;
	}
	return undefined;
}
