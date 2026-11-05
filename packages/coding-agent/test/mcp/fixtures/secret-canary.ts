import { randomUUID } from "node:crypto";

/**
 * Canary scanning for sealed secrets (D11 secret phase 8.3). Every capture is scanned as bytes. A secret's needles are
 * its raw, trimmed, 16-character-prefix and 16-character-suffix roots, each as UTF-8 and UTF-16LE bytes and as their
 * base64, base64url and hex text, plus the JSON-escaped and URI-encoded text. A secret that is base64url wire text
 * (a ciphertext or `enc`) also contributes its decoded bytes with the same encodings.
 */

export function canaryValue(): string {
	return ` canary-${randomUUID()}-"quoted"\\path `;
}

function roots(value: string): string[] {
	const trimmed = value.trim();
	return [...new Set([value, trimmed, trimmed.slice(0, 16), trimmed.slice(-16)])];
}

const TEXT_ENCODINGS: readonly BufferEncoding[] = ["base64", "base64url", "hex"];

function encodings(bytes: Buffer): Buffer[] {
	return [bytes, ...TEXT_ENCODINGS.map((encoding) => Buffer.from(bytes.toString(encoding)))];
}

export function secretNeedles(value: string): Buffer[] {
	const needles: Buffer[] = [];
	for (const root of roots(value)) {
		needles.push(...encodings(Buffer.from(root, "utf8")), ...encodings(Buffer.from(root, "utf16le")));
		needles.push(Buffer.from(JSON.stringify(root).slice(1, -1)), Buffer.from(encodeURIComponent(root)));
	}
	if (/^[A-Za-z0-9_-]{16,}$/.test(value)) needles.push(...encodings(Buffer.from(value, "base64url")));
	return needles.filter((needle) => needle.length >= 8);
}

export function sealedNeedles(frame: Readonly<Record<string, unknown>>): string[] {
	return [String(frame.ct), String(frame.enc)];
}

export function leaked(
	capture: string | Buffer,
	secrets: readonly string[],
	tokens: readonly string[] = [],
): string | undefined {
	const bytes = typeof capture === "string" ? Buffer.from(capture, "utf8") : capture;
	for (const secret of secrets)
		for (const needle of secretNeedles(secret)) if (bytes.includes(needle)) return needle.toString("latin1");
	// A JWT's prefix is its shared header, so a token is matched whole and by its payload and signature segments.
	for (const token of tokens)
		for (const part of [token, ...token.split(".").slice(1)])
			if (part.length >= 16 && bytes.includes(Buffer.from(part))) return part;
	return undefined;
}
