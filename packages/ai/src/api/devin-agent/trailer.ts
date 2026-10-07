/**
 * Connect end-of-stream trailer errors.
 *
 * Cascade rejects a turn (`invalid_argument`, `permission_denied`, ...) with an
 * HTTP 200 whose only frame is the trailer `{ error: { code, message, details } }`.
 * The trailer is the sole server-side evidence for such a rejection, so it is
 * parsed with guards - never asserted - and its details are folded into the
 * message a user sees.
 */

const MAX_TRAILER_EVIDENCE_CHARS = 2000;

export interface DevinTrailerError {
	code: string;
	message: string;
	formatted: string;
}

export function readDevinTrailerError(trailer: string): DevinTrailerError | undefined {
	const text = trailer.trim();
	if (!text) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || !isRecord(parsed.error)) return undefined;
	const code = typeof parsed.error.code === "string" ? parsed.error.code : "";
	const message = typeof parsed.error.message === "string" ? parsed.error.message : "";
	if (!code && !message) return undefined;
	const detail = summarizeDetails(parsed.error.details);
	return {
		code,
		message,
		formatted: `Devin stream error${code ? ` ${code}` : ""}: ${message}${detail ? ` [details: ${detail}]` : ""}`,
	};
}

function summarizeDetails(details: unknown): string | undefined {
	if (!Array.isArray(details) || details.length === 0) return undefined;
	const parts: string[] = [];
	for (const entry of details) {
		if (!isRecord(entry)) continue;
		const type = typeof entry.type === "string" && entry.type ? entry.type : undefined;
		const evidence = evidenceOf(entry);
		const part = type && evidence ? `${type}: ${evidence}` : (type ?? evidence);
		if (part) parts.push(part);
	}
	const summary = parts.join("; ");
	if (!summary) return undefined;
	return summary.length > MAX_TRAILER_EVIDENCE_CHARS ? `${summary.slice(0, MAX_TRAILER_EVIDENCE_CHARS)}…` : summary;
}

function evidenceOf(entry: Record<string, unknown>): string | undefined {
	if (entry.debug !== undefined) {
		if (typeof entry.debug === "string") return entry.debug;
		try {
			return JSON.stringify(entry.debug);
		} catch {
			return undefined;
		}
	}
	return typeof entry.value === "string" && entry.value ? entry.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
