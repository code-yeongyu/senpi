import { normalizeProviderError } from "../utils/error-body.ts";
import { formatProviderRequestId } from "../utils/retry.ts";

// Codes VS Code Copilot Chat treats as quota exhaustion (extensions/copilot chatMLFetcher.ts).
const QUOTA_CODES = new Set([
	"quota_exceeded",
	"free_quota_exceeded",
	"overage_limit_reached",
	"billing_not_configured",
	"additional_spend_limit_reached",
]);

function headerValue(headers: unknown, name: string): string | undefined {
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	if (typeof headers !== "object" || headers === null) return undefined;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name && typeof value === "string") return value;
	}
	return undefined;
}

function errorCode(body: string | undefined): string | undefined {
	if (body === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const nested = Reflect.get(parsed, "error");
		const code =
			typeof nested === "object" && nested !== null ? Reflect.get(nested, "code") : Reflect.get(parsed, "code");
		return typeof code === "string" ? code : undefined;
	} catch {
		return undefined;
	}
}

function isQuotaFailure(status: number, body: string | undefined, limitKey: string | undefined): boolean {
	const code = errorCode(body);
	if (code !== undefined && QUOTA_CODES.has(code)) return true;
	if (status === 402) return true;
	return status === 429 && (limitKey?.includes("quota") === true || /quota exceeded/i.test(body ?? ""));
}

/**
 * A plain-language note for a GitHub Copilot HTTP failure that the SDK message alone
 * leaves opaque (`403 status code (no body)`): which refusal it is, where to look, and
 * the GitHub request id support needs. `undefined` for failures the message already
 * explains. The wording avoids credential words so pool classification is unchanged.
 */
export function describeGitHubCopilotFailure(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	const { status, body } = normalizeProviderError(error);
	if (status === undefined) return undefined;
	const headers = Reflect.get(error, "headers");
	const requestId = headerValue(headers, "x-github-request-id");
	const reference = requestId === undefined ? "" : ` ${formatProviderRequestId("GitHub", requestId)}.`;
	if (isQuotaFailure(status, body, headerValue(headers, "x-ratelimit-exceeded"))) {
		return `GitHub Copilot quota exceeded (HTTP ${status}): the plan's included usage or its additional-usage limit is used up, so premium models are refused until it resets or the limit is raised. Usage is shown at https://github.com/settings/copilot.${reference}`;
	}
	if (status === 421) {
		return `GitHub Copilot sent this account to a different API host (HTTP 421 Misdirected Request): Business and Enterprise accounts are served from their own host, which senpi reads from the Copilot token. Run /login github-copilot so senpi stores the account's endpoint, and report it with the GitHub request id if it persists.${reference}`;
	}
	if (status === 403) {
		const reason = body === undefined ? " with an empty body" : "";
		return `GitHub Copilot refused the request (HTTP 403${reason}). Copilot checks access per model and per client; if a fresh /login github-copilot does not help, report it with the GitHub request id.${reference}`;
	}
	return undefined;
}

export function withGitHubCopilotFailureNote(message: string, provider: string, error: unknown): string {
	if (provider !== "github-copilot") return message;
	const note = describeGitHubCopilotFailure(error);
	return note === undefined ? message : `${message}\n${note}`;
}
