import type { ProviderDiagnostic } from "../../provider-diagnostic.ts";
import {
	buildProviderDiagnostic,
	categoryForProviderCode,
	classifyProviderFailure,
	isOpaqueProviderCode,
	isProviderDiagnosticResetsAt,
	isProviderDiagnosticStatus,
} from "../../utils/provider-diagnostic-vocabulary.ts";

/**
 * The providerDiagnostic for a ChatGPT-subscription (Codex backend) failure (senpi#3771). The
 * backend reports a refusal three ways: an HTTP error body, an in-stream `error` event (the
 * WebSocket form carries the HTTP status inline) and a `response.failed` event whose error sits
 * under `response.error`. All three name the error by `error.code` or `error.type` and may name the
 * reset by `resets_at` (epoch seconds) or `resets_in_seconds`.
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorCode(error: Record<string, unknown> | undefined): string | undefined {
	return nonEmptyString(error?.code) ?? nonEmptyString(error?.type);
}

function resetsAtMs(error: Record<string, unknown> | undefined, nowMs: number): number | undefined {
	const absolute = error?.resets_at;
	if (typeof absolute === "number" && Number.isFinite(absolute) && absolute > 0) {
		const ms = Math.round(absolute < 1e12 ? absolute * 1000 : absolute);
		return isProviderDiagnosticResetsAt(ms) ? ms : undefined;
	}
	const relative = error?.resets_in_seconds;
	if (typeof relative === "number" && Number.isFinite(relative) && relative >= 0) {
		const ms = Math.round(nowMs + relative * 1000);
		return isProviderDiagnosticResetsAt(ms) ? ms : undefined;
	}
	return undefined;
}

interface CodexFailureFacts {
	readonly status: number | undefined;
	readonly code: string | undefined;
	/** The event type, used as the code when the error names none (`response.failed`). */
	readonly fallbackCode?: string;
	readonly resetsAt: number | undefined;
}

function classifyCodexFailure(facts: CodexFailureFacts): ProviderDiagnostic | undefined {
	const status = isProviderDiagnosticStatus(facts.status) ? facts.status : undefined;
	const reset = facts.resetsAt === undefined ? {} : { resetsAt: facts.resetsAt };
	if (facts.code !== undefined && categoryForProviderCode(facts.code) !== undefined) {
		const classified =
			classifyProviderFailure({ status, code: facts.code }) ??
			classifyProviderFailure({ status: undefined, code: facts.code });
		return classified === undefined ? undefined : buildProviderDiagnostic({ ...classified, ...reset });
	}
	const byStatus = status === undefined ? undefined : classifyProviderFailure({ status, code: undefined });
	if (byStatus !== undefined && byStatus.category !== "unknown") return byStatus;
	const opaque = [facts.code, facts.fallbackCode].find(
		(code): code is string => code !== undefined && isOpaqueProviderCode(code),
	);
	if (opaque !== undefined)
		return buildProviderDiagnostic({ category: "unknown", code: opaque, evidence: "structured_code" });
	return byStatus;
}

export function codexHttpProviderDiagnostic(
	status: number,
	bodyText: string,
	nowMs: number = Date.now(),
): ProviderDiagnostic | undefined {
	let error: Record<string, unknown> | undefined;
	try {
		error = asRecord(asRecord(JSON.parse(bodyText))?.error);
	} catch {
		error = undefined;
	}
	return classifyCodexFailure({ status, code: errorCode(error), resetsAt: resetsAtMs(error, nowMs) });
}

export function codexEventProviderDiagnostic(
	event: Record<string, unknown>,
	nowMs: number = Date.now(),
): ProviderDiagnostic | undefined {
	const response = asRecord(event.response);
	const error = asRecord(event.error) ?? asRecord(response?.error);
	const status = typeof event.status === "number" ? event.status : undefined;
	const eventType = nonEmptyString(event.type);
	return classifyCodexFailure({
		status,
		code: errorCode(error) ?? nonEmptyString(event.code),
		...(eventType === undefined ? {} : { fallbackCode: eventType }),
		resetsAt: resetsAtMs(error, nowMs),
	});
}
