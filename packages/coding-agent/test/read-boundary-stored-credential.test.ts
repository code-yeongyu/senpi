import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readStoredCredential } from "../src/core/auth-storage.ts";

// Read boundary (c) of senpi#1989: an auth.json written by an earlier version
// is keyed by the LEGACY provider id. Every read must try the canonical key and
// then the legacy spelling, so a logged-in user is never reported logged out.
// Nothing is rewritten by these reads.
const dirs: string[] = [];
function authFile(data: unknown): string {
	const d = mkdtempSync(join(tmpdir(), "t8-auth-"));
	dirs.push(d);
	mkdirSync(d, { recursive: true });
	const p = join(d, "auth.json");
	writeFileSync(p, JSON.stringify(data, null, 2));
	return p;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const OAUTH = { type: "oauth", access: "a", refresh: "r", expires: 0 } as const;

describe("read boundary: stored credential lookup (senpi#1989)", () => {
	it("finds a credential stored under the legacy provider id", () => {
		const p = authFile({ "claude-sdk-oauth": OAUTH });
		expect(readStoredCredential("anthropic-subscription", p)).toMatchObject({ access: "a" });
	});

	it("finds a credential stored under the canonical id", () => {
		const p = authFile({ "anthropic-subscription": OAUTH });
		expect(readStoredCredential("anthropic-subscription", p)).toMatchObject({ access: "a" });
	});

	it("prefers the canonical entry when both spellings are present", () => {
		const p = authFile({ "anthropic-subscription": { ...OAUTH, access: "canonical" }, "claude-sdk-oauth": OAUTH });
		expect(readStoredCredential("anthropic-subscription", p)).toMatchObject({ access: "canonical" });
	});

	it("keeps the untouched API-key provider separate from the subscription lane", () => {
		const p = authFile({ anthropic: { type: "api_key", key: "sk-test" }, "claude-sdk-oauth": OAUTH });
		expect(readStoredCredential("anthropic", p)).toMatchObject({ type: "api_key" });
		// the subscription lane resolves its own legacy credential, not the API key
		expect(readStoredCredential("anthropic-subscription", p)).toMatchObject({ type: "oauth" });
	});

	it("resolves the ChatGPT lane's legacy key too", () => {
		const p = authFile({ "openai-codex": OAUTH });
		expect(readStoredCredential("chatgpt-subscription", p)).toMatchObject({ access: "a" });
	});

	it("returns undefined for an absent provider without throwing", () => {
		const p = authFile({ "some-other": OAUTH });
		expect(readStoredCredential("anthropic-subscription", p)).toBeUndefined();
	});
});
