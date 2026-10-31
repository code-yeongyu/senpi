import { describe, expect, it } from "vitest";
import { redactShareText, type ShareRedactionContext } from "../../../src/core/share/share-redaction.ts";
import { redactShareValue } from "../../../src/core/share/share-redaction-value.ts";
import { isSensitiveKeyName } from "../../../src/core/share/share-sensitive-key.ts";

// senpi#3524 review round 7: a value under a sensitive key is replaced whole, judged by the key name alone, so no value
// shape (placeholders anywhere, hex, several words) can slip through. Secrets are assembled at runtime.

const context: ShareRedactionContext = { homeDirectory: "/Users/jane doe", userName: "janedoe", hostName: "h.local" };
const HEX = "0123456789abcdef".repeat(3).slice(0, 40);
const HALF = HEX.slice(0, 20);
const P = "<redacted>";

function text(input: string): string {
	return redactShareText(input, context, new Map());
}

describe("sensitive keys are judged by name (senpi#3524)", () => {
	it.each([
		"DEEPSEEK_KEY",
		"STORAGE_KEY",
		"OPENAI_API_KEY",
		"ANTHROPIC_AUTH",
		"DB_PASS",
		"DB_PASSWORD",
		"GITHUB_TOKEN",
		"CLIENT_SECRET",
		"apiKey",
		"accessToken",
		"refresh_token",
		"secretKey",
		"privateKey",
		"sessionId",
		"x-api-key",
		"Cookie",
		"AWS_SECRET_ACCESS_KEY",
		"credentials",
		"KEY",
		"key",
		"keys",
		"token",
		"secret",
		"PUBLIC_KEY_SECRET",
		"NEXT_PUBLIC_TOKEN_SECRET",
		"NEXT_AUTH_SECRET",
		"VITE_API_KEY",
		"VITE_OPENAI_API_KEY",
		"MAX_PASSWORD",
		"SECRET_TOKEN_NAME",
		"PASSWORD_PREFIX",
		"AUTH_HEADER",
		"AUTH_MODE_PASSWORD",
		"KEY_ID_PRIVATE",
		"cookies[0].value",
		"API_TOKEN_PATH",
		"API_TOKEN_FILE",
		"GITHUB_TOKEN_MODE",
		"SECRET_SIZE",
		"PASSWORD_TYPE",
		"PASSWORD_LENGTH",
		"tokenCount",
		"NEXT_PUBLIC_KEY_ID",
		"AWS_ACCESS_KEY_ID",
		"API_KEY_ID",
		"KEY_IDS",
		"DB_PASSWORD_URL",
		"SECRET_KEY_FILE",
	])("treats %s as sensitive", (name) => {
		expect(isSensitiveKeyName(name)).toBe(true);
	});

	it.each([
		"PATH",
		"HOME",
		"NODE_ENV",
		"LANG",
		"PUBLIC_KEY_PATH",
		"AUTH_MODE",
		"KEYBOARD_LAYOUT",
		"MONKEY_COUNT",
		"maxTokens",
		"max_output_tokens",
		"KEY_ID",
		"publicKey",
		"public-key-path",
	])("treats %s as ordinary", (name) => {
		expect(isSensitiveKeyName(name)).toBe(false);
	});

	it.each([
		["a leading placeholder", `${P}${HEX}`],
		["a trailing placeholder", `${HEX}${P}`],
		["an interleaved placeholder", `${HALF}${P}${HALF}`],
		["repeated placeholders", `${P}${P}${HEX}${P}${P}`],
		["mixed pieces", `${P}${HALF}${P}${HALF}${P}`],
		["two words", `correct horse ${HEX}`],
	])("replaces a value with %s whole, in env text and quoted text", (_label, value) => {
		for (const line of [`DEEPSEEK_KEY=${value}`, `STORAGE_KEY = "${value}"`, `DB_PASS: ${value}`]) {
			const out = text(line);
			expect(out).not.toContain(HALF);
			expect(out).not.toContain("horse");
		}
	});

	it("replaces structured values under sensitive names whole and keeps ordinary ones", () => {
		const out = redactShareValue(
			{
				DEEPSEEK_KEY: HEX,
				STORAGE_KEY: `${HEX}${P}`,
				PATH: "/usr/bin",
				NODE_ENV: "production",
				key: "row-1",
				name: "x",
			},
			context,
			new Map(),
		);
		expect(out).toEqual({
			DEEPSEEK_KEY: P,
			STORAGE_KEY: P,
			PATH: "/usr/bin",
			NODE_ENV: "production",
			key: P,
			name: "x",
		});
	});

	it.each(['const STORAGE_KEY = "app-settings";', "CACHE_KEY=user-cache-v2", "SORT_KEY: createdAt"])(
		"over-redacts a constant under a KEY name on purpose: %s",
		(line) => {
			expect(text(line)).toContain("<redacted>");
		},
	);

	it.each([
		["a bare upper-case KEY", `KEY=${HEX}`],
		["a bracketed path key", `cookies[0].value=${HEX}`],
		["a public prefix hiding a secret", `NEXT_PUBLIC_TOKEN_SECRET=${HEX}`],
		["a public key with a secret after it", `PUBLIC_KEY_SECRET: "${HEX}"`],
		["a token name ending in path", `API_TOKEN_PATH=${HEX}`],
		["a token name ending in mode", `GITHUB_TOKEN_MODE=${HEX}`],
		["a secret name ending in size", `SECRET_SIZE=${HEX}`],
		["a password name ending in type", `PASSWORD_TYPE=${HALF}`],
	])("redacts %s in text", (_label, line) => {
		expect(text(line)).not.toContain(HALF);
	});

	it("redacts a public-prefixed secret in structured data", () => {
		const out = redactShareValue({ NEXT_AUTH_SECRET: HEX, PUBLIC_KEY_SECRET: HEX }, context, new Map());
		expect(out).toEqual({ NEXT_AUTH_SECRET: P, PUBLIC_KEY_SECRET: P });
	});

	it("keeps ordinary env lines and public names unchanged", () => {
		const lines = [
			"PATH=/usr/local/bin:/usr/bin",
			"NODE_ENV=production",
			"AUTH_MODE=oauth",
			"PUBLIC_KEY_PATH=/etc/ssl/pub.pem",
			"KEYBOARD_LAYOUT=us",
		].join("\n");
		expect(text(lines)).toBe(lines);
	});
});
