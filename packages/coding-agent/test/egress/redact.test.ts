import { describe, expect, it } from "vitest";
import { createRedactor, REDACTED } from "../../src/core/egress/redact.ts";
import { syntheticSecret } from "./synthetic-secret.ts";

const SECRET = `sk-ant-api03-${syntheticSecret(1, 24)}`;
const PUBLIC_PREFIXES = ["sk-ant-api03-"];

function embeddedBase64(secret: string, offset: number, url = false): string {
	const bytes = Buffer.concat([Buffer.from("xyz".slice(0, offset)), Buffer.from(secret), Buffer.from("!!")]);
	return bytes.toString(url ? "base64url" : "base64");
}

describe("redact: whole-value forms of a sealed secret", () => {
	const redactor = createRedactor({ secrets: [SECRET], publicPrefixes: PUBLIC_PREFIXES });

	it("replaces the raw secret as one token", () => {
		expect(redactor.redact(`Authorization: Bearer ${SECRET}`)).toBe(`Authorization: Bearer ${REDACTED}`);
	});

	it("replaces the URL-encoded form of a secret with reserved characters", () => {
		const secret = "k3y/with+plus=and space";
		const encoded = createRedactor({ secrets: [secret], publicPrefixes: [] });
		expect(encoded.redact(`?key=${encodeURIComponent(secret)}`)).toBe(`?key=${REDACTED}`);
	});

	it.each([
		[0, false],
		[1, false],
		[2, false],
		[0, true],
		[1, true],
		[2, true],
	])("removes the base64 form at byte alignment %i (url-safe: %s)", (offset, url) => {
		const payload = embeddedBase64(SECRET, offset, url);
		const out = redactor.redact(`blob ${payload} end`);
		expect(out).toContain(REDACTED);
		// Characters 8..40 of the payload are determined by secret bytes alone at every alignment.
		expect(out).not.toContain(payload.slice(8, 40));
		expect(out.startsWith("blob ")).toBe(true);
		expect(out.endsWith(" end")).toBe(true);
	});

	it("removes an 8-character fragment of the secret on its own", () => {
		const fragment = SECRET.slice(20, 28);
		expect(redactor.redact(`partial echo: ${fragment} end`)).toBe(`partial echo: ${REDACTED} end`);
	});

	it("keeps a known public prefix that occurs without the secret", () => {
		expect(redactor.redact("keys look like sk-ant-api03-... in the docs")).toBe(
			"keys look like sk-ant-api03-... in the docs",
		);
	});
});

describe("redact: span merging", () => {
	const secret = syntheticSecret(2, 20);
	const redactor = createRedactor({ secrets: [secret], publicPrefixes: [] });

	it("merges overlapping and touching 8-gram matches into one span", () => {
		expect(redactor.redact(`${secret}${secret.slice(3, 15)} tail`)).toBe(`${REDACTED} tail`);
	});
});

describe("redact: short secrets and token boundaries", () => {
	const redactor = createRedactor({ secrets: ["q7Rz9a"], publicPrefixes: [] });

	it("redacts a 6-character secret as a whole token", () => {
		expect(redactor.redact("pin=q7Rz9a;")).toBe(`pin=${REDACTED};`);
	});

	it("leaves a 6-character secret inside a longer token untouched", () => {
		expect(redactor.redact("xq7Rz9ay")).toBe("xq7Rz9ay");
	});
});

describe("redact: periodic secrets", () => {
	it.each([
		["one repeated character", "A".repeat(4096)],
		["a two-character period", "ab".repeat(2048)],
		["a long run inside a varied secret", `x9${"A".repeat(4000)}Qz7`],
	])("redacts a 4 KB secret with %s", (_label, secret) => {
		const redactor = createRedactor({ secrets: [secret], publicPrefixes: [] });
		expect(redactor.redact(`key=${secret};`)).toBe(`key=${REDACTED};`);
		expect(redactor.redact(`echo ${secret.slice(0, 8)}!`)).toBe(`echo ${REDACTED}!`);
	});
});

describe("redact: false-positive corpus", () => {
	const redactor = createRedactor({ secrets: [SECRET, "q7Rz9a"], publicPrefixes: PUBLIC_PREFIXES });

	it.each([
		"GET /v1/messages HTTP/1.1",
		"The quick brown fox jumps over the lazy dog 0123456789",
		"model=claude-opus-5-5 max_tokens=4096 stream=true",
		"https://api.anthropic.com/v1/complete?beta=true",
		"error: rate_limit_error (429) retry-after: 30",
	])("passes %j through unchanged", (line) => {
		expect(redactor.redact(line)).toBe(line);
	});

	it("uses only sealed values as patterns", () => {
		const noSecrets = createRedactor({ secrets: [], publicPrefixes: [] });
		expect(noSecrets.redact(`echo ${SECRET}`)).toBe(`echo ${SECRET}`);
	});
});
