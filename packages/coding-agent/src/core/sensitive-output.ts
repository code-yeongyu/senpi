export function redactSensitiveOutput(text: string): string {
	return redactSensitiveTokenValues(
		text
			.replace(/\b([A-Z][A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|AUTH)[A-Z0-9_]*)=([^\s'"]+)/g, "$1=[REDACTED]")
			.replace(/\b(Authorization:\s*Bearer\s+)([^\s'"]+)/gi, "$1[REDACTED]")
			.replace(/\b(Bearer\s+)(sk-[A-Za-z0-9._-]+)/g, "$1[REDACTED]"),
	);
}

export function redactSensitiveTokenValues(text: string, replacement = "[REDACTED]"): string {
	return text
		.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, replacement)
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement);
}
