import { redactCredentialShapes, redactSecrets as redactProviderSecrets } from "@earendil-works/pi-ai";
import { redactResolvedReferenceValues } from "./config-reference-redaction.ts";

// An environment assignment whose name contains a credential word. One class up to the "=", anchored at a word start,
// keeps the match linear; a pattern with characters on both sides of the word was quadratic on one long name
// (senpi#4283). The name test runs once per assignment on that name only.
const ENV_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*)=([^\s'"]+)/g;
const ENV_SECRET_WORD = /API_KEY|SECRET|TOKEN|PASSWORD|AUTH/;
const LOG_CREDENTIAL_TEXT =
	/((?:authorization\s*[:=]\s*(?:bearer|basic)\s+)|(?:bearer\s+)|(?:[?&](?:api[_-]?key|token|secret|password|auth(?:orization)?)=))[^\s&,"'}\]]+/gi;

export function redactSensitiveOutput(text: string): string {
	return redactSensitiveTokenValues(
		text
			.replace(ENV_ASSIGNMENT, (all, name: string) =>
				ENV_SECRET_WORD.test(name.slice(1)) ? `${name}=[REDACTED]` : all,
			)
			.replace(/\b(Authorization:\s*Bearer\s+)([^\s'"]+)/gi, "$1[REDACTED]")
			.replace(/\b(Bearer\s+)(sk-[A-Za-z0-9._-]+)/g, "$1[REDACTED]"),
	);
}

export function redactSensitiveTokenValues(text: string, replacement = "[REDACTED]"): string {
	return redactCredentialShapes(redactResolvedReferenceValues(text, replacement), replacement);
}

/**
 * Every diagnostic log writer (session, config-reload, moved-path-guard, compaction) runs each string it writes through
 * this before truncating it (senpi#6337): a resolved reference value or a credential shape is replaced, then an
 * authorization header or credential query parameter keeps its name with the value replaced. Truncating first could
 * leave a prefix of a value that no longer matches.
 */
export function redactLogText(text: string): string {
	return redactSensitiveTokenValues(text, "[redacted]").replace(LOG_CREDENTIAL_TEXT, "$1[redacted]");
}

/**
 * Every sink of provider error text uses this: the session's own rules (environment assignments, resolved config
 * references) and pi-ai's value-based credential redaction, the same rules the provider stream applies.
 */
export function redactSecrets(text: string, replacement = "[REDACTED]"): string {
	const session = redactSensitiveOutput(text);
	const marked = replacement === "[REDACTED]" ? session : session.replaceAll("[REDACTED]", replacement);
	return redactProviderSecrets(redactSensitiveTokenValues(marked, replacement), replacement);
}
