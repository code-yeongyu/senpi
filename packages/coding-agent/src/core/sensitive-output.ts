import { redactCredentialShapes, redactSecrets as redactProviderSecrets } from "@earendil-works/pi-ai";
import { redactResolvedReferenceValues } from "./config-reference-redaction.ts";

// An environment assignment whose name contains a credential word. One class up to the "=", anchored at a word start,
// keeps the match linear; a pattern with characters on both sides of the word was quadratic on one long name
// (senpi#4283). The name test runs once per assignment on that name only.
const ENV_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*)=([^\s'"]+)/g;
const ENV_SECRET_WORD = /API_KEY|SECRET|TOKEN|PASSWORD|AUTH/;

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
 * Every sink of provider error text uses this: the session's own rules (environment assignments, resolved config
 * references) and pi-ai's value-based credential redaction, the same rules the provider stream applies.
 */
export function redactSecrets(text: string, replacement = "[REDACTED]"): string {
	const session = redactSensitiveOutput(text);
	const marked = replacement === "[REDACTED]" ? session : session.replaceAll("[REDACTED]", replacement);
	return redactProviderSecrets(redactSensitiveTokenValues(marked, replacement), replacement);
}
