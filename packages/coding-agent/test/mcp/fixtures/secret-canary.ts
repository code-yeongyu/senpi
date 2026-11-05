import { randomUUID } from "node:crypto";

/**
 * Canary scanning for sealed secrets (D11 secret phase 8.3): the canonical variant set (raw, JSON-escaped, base64,
 * base64url, hex and URI-encoded) plus UTF-16LE, over the raw, trimmed, 16-character-prefix and 16-character-suffix
 * roots. A capture leaks when it contains any variant.
 */

export function canaryValue(): string {
	return ` canary-${randomUUID()}-"quoted"\\path `;
}

function roots(value: string): string[] {
	const trimmed = value.trim();
	return [...new Set([value, trimmed, trimmed.slice(0, 16), trimmed.slice(-16)])];
}

export function secretVariants(value: string): string[] {
	const out = new Set<string>();
	for (const root of roots(value)) {
		const utf8 = Buffer.from(root, "utf8");
		const utf16 = Buffer.from(root, "utf16le");
		for (const bytes of [utf8, utf16]) {
			out.add(bytes.toString("base64"));
			out.add(bytes.toString("base64url"));
			out.add(bytes.toString("hex"));
		}
		out.add(root);
		out.add(JSON.stringify(root).slice(1, -1));
		out.add(encodeURIComponent(root));
		out.add(utf16.toString("latin1"));
	}
	return [...out].filter((variant) => variant.length >= 8);
}

export function leaked(
	capture: string,
	secrets: readonly string[],
	tokens: readonly string[] = [],
): string | undefined {
	for (const secret of secrets)
		for (const variant of secretVariants(secret)) if (capture.includes(variant)) return variant;
	// A JWT's prefix is its shared header, so a token is matched whole and by its payload and signature segments.
	for (const token of tokens)
		for (const part of [token, ...token.split(".").slice(1)])
			if (part.length >= 16 && capture.includes(part)) return part;
	return undefined;
}
