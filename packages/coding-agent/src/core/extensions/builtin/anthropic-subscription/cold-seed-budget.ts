import {
	type Api,
	type AssistantMessage,
	type AssistantMessageDiagnostic,
	type Context,
	isContextOverflow,
	type Model,
} from "@earendil-works/pi-ai";
import { serializedPayloadBytes } from "./prompt-directive-dedupe.ts";
import type { ContentBlockParam } from "./sdk-boundary.ts";

/**
 * Marks an assistant turn that failed because a cold-seed (flatten/bootstrap)
 * request did not fit the model window. A cold-seed re-sends senpi's own
 * history as ONE user message, which the Claude Agent SDK cannot compact, so
 * the compaction lane policy reads this marker to let senpi own the recovery.
 * It is persisted with the message, so a restarted session still recovers.
 */
export const COLD_SEED_OVERFLOW_DIAGNOSTIC = "claude_sdk_oauth_cold_seed_overflow";

/**
 * Claude's tokenizer spends at least one token per ~4 UTF-8 bytes on realistic
 * prose, code, JSON and CJK text, so bytes/4 under-counts rather than over-counts:
 * a request this estimate already places over the window cannot be accepted.
 * Images and Claude Code's own preamble are left out for the same reason.
 */
const UTF8_BYTES_PER_TOKEN_FLOOR = 4;

/**
 * A rejection that names its count measures how far bytes/4 under-counted THIS
 * session's content (code, JSON tool results and CJK text tokenize denser). The
 * ratio is clamped: below 1 the count cannot be trusted, above this cap the
 * message was not about the payload (a provider-side limit or a bad parse).
 */
const MAX_CALIBRATION_RATIO = 8;

const OWN_REFUSAL_PREFIX = "The conversation is too long to resend";

export type ColdSeedOverflowDetails = {
	estimatedTokens?: number;
	reportedTokens?: number;
	reportedLimit?: number;
};

export class ColdSeedOverflowError extends Error {
	readonly estimatedTokens: number;
	readonly contextWindow: number;

	constructor(estimatedTokens: number, contextWindow: number) {
		// pi-ai's OVERFLOW_PATTERNS matches this wording, so overflow recovery takes it like an API rejection.
		super(
			`${OWN_REFUSAL_PREFIX} (about ${estimatedTokens} tokens, limit ${contextWindow}). Compacting it and retrying.`,
		);
		this.name = "ColdSeedOverflowError";
		this.estimatedTokens = estimatedTokens;
		this.contextWindow = contextWindow;
	}
}

export function estimateColdSeedTokens(
	context: Pick<Context, "systemPrompt" | "tools">,
	blocks: readonly ContentBlockParam[],
): number {
	const fixedBytes =
		Buffer.byteLength(context.systemPrompt ?? "", "utf8") +
		Buffer.byteLength(JSON.stringify(context.tools ?? []), "utf8");
	return Math.ceil((fixedBytes + serializedPayloadBytes(blocks)) / UTF8_BYTES_PER_TOKEN_FLOOR);
}

/** Sessions whose calibration a long-lived host keeps; the oldest-touched is dropped past it. */
const MAX_CALIBRATED_SESSIONS = 256;
const calibrationBySession = new Map<string, number>();

/** Tokens the API counts per token bytes/4 estimated, learned from this session's rejected cold-seeds; 1 until one is seen. */
export function coldSeedCalibration(sessionId: string | undefined): number {
	return (sessionId !== undefined && calibrationBySession.get(sessionId)) || 1;
}

function raiseCalibration(sessionId: string, estimatedTokens: number, reportedTokens: number): void {
	if (!(estimatedTokens > 0) || !(reportedTokens > 0)) return;
	const ratio = Math.min(MAX_CALIBRATION_RATIO, reportedTokens / estimatedTokens);
	if (ratio <= coldSeedCalibration(sessionId)) return;
	calibrationBySession.delete(sessionId);
	calibrationBySession.set(sessionId, ratio);
	const oldest = calibrationBySession.keys().next().value;
	if (calibrationBySession.size > MAX_CALIBRATED_SESSIONS && oldest !== undefined) calibrationBySession.delete(oldest);
}

/**
 * A restarted process has an empty map, but the counts that taught it are persisted
 * on the session's cold-seed overflow markers: re-learn from the newest marker that
 * carries both an estimate and a provider-reported count.
 */
export function restoreColdSeedCalibration(
	sessionId: string,
	branch: readonly { type: string; message?: { role: string; diagnostics?: readonly AssistantMessageDiagnostic[] } }[],
): void {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const message = branch[index]?.type === "message" ? branch[index]?.message : undefined;
		if (message?.role !== "assistant") continue;
		const marker = message.diagnostics?.find((diagnostic) => diagnostic.type === COLD_SEED_OVERFLOW_DIAGNOSTIC);
		const details = marker?.details as ColdSeedOverflowDetails | undefined;
		if (details?.estimatedTokens === undefined || details.reportedTokens === undefined) continue;
		raiseCalibration(sessionId, details.estimatedTokens, details.reportedTokens);
		return;
	}
}

export function forgetColdSeedCalibration(sessionId?: string): void {
	if (sessionId === undefined) calibrationBySession.clear();
	else calibrationBySession.delete(sessionId);
}

/**
 * Reads the counts a provider rejection reports. Claude Code words an oversized
 * single-exchange request as "the request is ~N tokens (limit M)"; the API itself
 * says "prompt is too long: N tokens > M maximum"; the pre-dispatch refusal below
 * says "about N tokens, limit M".
 */
export function parseReportedOverflowTokens(
	errorMessage: string | undefined,
): { reportedTokens: number; reportedLimit: number } | undefined {
	if (!errorMessage) return undefined;
	const match =
		/~?(\d[\d,]*)\s+tokens?\s*\(limit\s+(\d[\d,]*)\)/i.exec(errorMessage) ??
		/(\d[\d,]*)\s+tokens?\s*>\s*(\d[\d,]*)\s+maximum/i.exec(errorMessage) ??
		/about\s+(\d[\d,]*)\s+tokens?,\s*limit\s+(\d[\d,]*)/i.exec(errorMessage);
	if (!match) return undefined;
	const reportedTokens = Number(match[1].replaceAll(",", ""));
	const reportedLimit = Number(match[2].replaceAll(",", ""));
	if (!(reportedTokens > 0) || !(reportedLimit > 0)) return undefined;
	return { reportedTokens, reportedLimit };
}

export function coldSeedOverflow(
	model: Model<Api>,
	estimatedTokens: number,
	calibration = 1,
): ColdSeedOverflowError | undefined {
	if (!(model.contextWindow > 0)) return undefined;
	const calibratedTokens = Math.ceil(estimatedTokens * Math.max(1, calibration));
	return calibratedTokens > model.contextWindow
		? new ColdSeedOverflowError(calibratedTokens, model.contextWindow)
		: undefined;
}

export function markColdSeedOverflow(
	output: AssistantMessage,
	model: Model<Api>,
	coldSeedAttempt: boolean,
	estimatedTokens?: number,
	sessionId?: string,
): void {
	if (!coldSeedAttempt || output.stopReason !== "error" || !isContextOverflow(output, model.contextWindow)) return;
	// The lane's own refusal reports its calibrated estimate, not a provider count:
	// learning from it would only feed the current ratio (plus rounding) back in.
	const ownRefusal = output.errorMessage?.startsWith(OWN_REFUSAL_PREFIX) === true;
	const reported = ownRefusal ? undefined : parseReportedOverflowTokens(output.errorMessage);
	const details: ColdSeedOverflowDetails = {
		...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
		...(reported ?? {}),
	};
	if (sessionId !== undefined && reported && estimatedTokens !== undefined) {
		raiseCalibration(sessionId, estimatedTokens, reported.reportedTokens);
	}
	output.diagnostics = [
		...(output.diagnostics ?? []),
		{ type: COLD_SEED_OVERFLOW_DIAGNOSTIC, timestamp: Date.now(), details } satisfies AssistantMessageDiagnostic,
	];
}

export function isColdSeedOverflowMessage(message: {
	role: string;
	diagnostics?: readonly AssistantMessageDiagnostic[];
}): boolean {
	return (
		message.role === "assistant" &&
		(message.diagnostics ?? []).some((diagnostic) => diagnostic.type === COLD_SEED_OVERFLOW_DIAGNOSTIC)
	);
}
