/**
 * Which keys hold credentials (#3524). The decision is made from the key's name
 * alone: a value under a sensitive key is replaced whole, whatever it contains,
 * so no value shape (placeholders, hex, several words) can slip through. Names
 * are split into words across camelCase, snake_case, kebab-case and dots.
 *
 * Bounded by design: ANY sensitive word anywhere in the name makes it sensitive.
 * The only exceptions are a short list of exact names; there are no word-level
 * exemptions, so no combination of allowed words can hide a secret.
 */

const SENSITIVE_WORDS = new Set([
	"key",
	"keys",
	"apikey",
	"token",
	"tokens",
	"secret",
	"secrets",
	"pass",
	"passwd",
	"password",
	"passwords",
	"passphrase",
	"pwd",
	"auth",
	"authorization",
	"credential",
	"credentials",
	"cookie",
	"cookies",
	"session",
	"sessionid",
	"private",
	"signature",
]);

/** Exact names (compared as lower snake_case) that describe a credential without holding one. */
const ORDINARY_NAMES = new Set([
	"public_key",
	"public_key_path",
	"key_id",
	"auth_mode",
	"auth_type",
	"max_tokens",
	"max_output_tokens",
]);

function words(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 0);
}

export function isSensitiveKeyName(name: string): boolean {
	const parts = words(name);
	if (!parts.some((word) => SENSITIVE_WORDS.has(word))) return false;
	return !ORDINARY_NAMES.has(parts.join("_"));
}
