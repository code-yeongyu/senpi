import type { ProviderDiagnostic } from "../provider-diagnostic.ts";
import { attachProviderDiagnostic } from "./provider-diagnostic-carrier.ts";
import { classifyProviderFailure } from "./provider-diagnostic-vocabulary.ts";

/** Largest SSE error envelope parsed for classification at all. */
const SSE_ERROR_ENVELOPE_MAX_BYTES = 8_192;

type ErrorClassifier = (error: unknown) => ProviderDiagnostic | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined | null {
	if (value === undefined || value === null) return undefined;
	return typeof value === "string" ? value : null;
}

/**
 * Anthropic SDK `APIError`: reads `status`, the direct `type`, and the body's
 * nested `error.type` once each. Direct and nested tokens that disagree, or a
 * non-string token, yield nothing. Message, headers and request id are never read.
 */
export function anthropicProviderDiagnosticFromError(error: unknown): ProviderDiagnostic | undefined {
	try {
		if (!(error instanceof Error)) return undefined;
		const status = Reflect.get(error, "status");
		const direct = optionalString(Reflect.get(error, "type"));
		const body = Reflect.get(error, "error");
		const nested = isRecord(body) && isRecord(body.error) ? optionalString(body.error.type) : undefined;
		if (direct === null || nested === null) return undefined;
		if (direct !== undefined && nested !== undefined && direct !== nested) return undefined;
		const code = direct ?? nested;
		if (code === undefined && (status === undefined || status === null)) return undefined;
		return classifyProviderFailure({ status, code });
	} catch {
		return undefined;
	}
}

/** Anthropic explicit `event: error` envelope, classified before it collapses into an Error message. */
export function anthropicProviderDiagnosticFromSseData(data: string): ProviderDiagnostic | undefined {
	try {
		if (new TextEncoder().encode(data).length > SSE_ERROR_ENVELOPE_MAX_BYTES) return undefined;
		const parsed: unknown = JSON.parse(data);
		if (!isRecord(parsed) || parsed.type !== "error" || !isRecord(parsed.error)) return undefined;
		const code = parsed.error.type;
		if (typeof code !== "string") return undefined;
		return classifyProviderFailure({ status: undefined, code });
	} catch {
		return undefined;
	}
}

/**
 * OpenAI SDK `APIError` (HTTP rejection or in-stream error chunk): reads
 * `status` and `code` once each. `type` is ignored because OpenAI-compatible
 * servers reuse it for coarse buckets that can contradict the precise code.
 */
export function openAICompatibleProviderDiagnosticFromError(error: unknown): ProviderDiagnostic | undefined {
	try {
		if (!(error instanceof Error)) return undefined;
		const status = Reflect.get(error, "status");
		const code = optionalString(Reflect.get(error, "code"));
		if (code === null) return undefined;
		if (code === undefined && (status === undefined || status === null)) return undefined;
		return classifyProviderFailure({ status, code });
	} catch {
		return undefined;
	}
}

/**
 * Await one provider transport call and, if it rejects, attach the classifier's
 * verdict to the rejection. Only errors raised by the wrapped call are
 * classified, so caller callbacks and local failures never gain provider provenance.
 */
export async function awaitProviderTransport<T>(request: () => Promise<T>, classify: ErrorClassifier): Promise<T> {
	try {
		return await request();
	} catch (error) {
		if (typeof error === "object" && error !== null) attachProviderDiagnostic(error, classify(error));
		throw error;
	}
}

/** Iterate a provider SDK stream, attaching the classifier's verdict to any error the stream itself raises. */
export async function* iterateProviderTransport<T>(
	source: AsyncIterable<T>,
	classify: ErrorClassifier,
): AsyncGenerator<T> {
	try {
		yield* source;
	} catch (error) {
		if (typeof error === "object" && error !== null) attachProviderDiagnostic(error, classify(error));
		throw error;
	}
}
