import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { redactShareText } from "../../../src/core/share/share-redaction.ts";

async function extensionApi(): Promise<ExtensionAPI> {
	const { createExtensionRuntime, loadExtensionFromFactory } = await import("../../../src/core/extensions/loader.ts");
	let captured: ExtensionAPI | undefined;
	await loadExtensionFromFactory(
		(pi) => {
			captured = pi;
		},
		"/tmp",
		createEventBus(),
		createExtensionRuntime(),
		"<feedback-ext>",
	);
	if (!captured) throw new Error("the factory never ran");
	return captured;
}

describe("#3674 pi.redactForUpload", () => {
	it("removes credentials and this machine's home path from text an extension uploads, and counts them", async () => {
		// Given
		const pi = await extensionApi();
		const text = `cd ${homedir()}/work && export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx1234`;

		// When
		const result = pi.redactForUpload(text);

		// Then
		expect(result.text).not.toContain(homedir());
		expect(result.text).not.toContain("sk-proj-abcdefghijklmnopqrstuvwx1234");
		expect(result.counts["home path"]).toBe(1);
		expect(result.counts.credential).toBeGreaterThanOrEqual(1);
	});

	it("also removes extra identity literals the caller knows about, such as a remote host's account name", async () => {
		const pi = await extensionApi();

		const result = pi.redactForUpload("ssh build-runner-07 as deploybot failed", {
			extraLiterals: ["build-runner-07", "deploybot"],
		});

		expect(result.text).not.toContain("build-runner-07");
		expect(result.text).not.toContain("deploybot");
	});

	it("keeps earlier placeholders intact when an extra literal is also a placeholder word", async () => {
		const pi = await extensionApi();

		const result = pi.redactForUpload("Bearer abcdefghijkl1234 sent to user@example.com from redacted-host", {
			extraLiterals: ["redacted", "email", "user", "host"],
		});

		expect(result.text).toContain("<redacted>");
		expect(result.text).toContain("<email>");
		expect(result.text).not.toMatch(/<<|>>/);
		expect(pi.redactForUpload(result.text, { extraLiterals: ["redacted", "email", "user", "host"] }).text).toBe(
			result.text,
		);
	});

	it("is idempotent: running it on its own output changes nothing and counts nothing", async () => {
		const pi = await extensionApi();
		const first = pi.redactForUpload(`token ghp_${"a".repeat(36)} at ${homedir()}/x`);

		const second = pi.redactForUpload(first.text);

		expect(second.text).toBe(first.text);
		expect(Object.values(second.counts).reduce((sum, n) => sum + n, 0)).toBe(0);
	});

	it("is the same redaction /share applies: identical input gives identical text", async () => {
		const pi = await extensionApi();
		const { currentShareRedactionContext } = await import("../../../src/core/share/share-redaction.ts");
		const input = `user@example.com wrote ${homedir()}/notes with Bearer abcdefghijklmnopqrstuvwxyz012345`;

		const viaExtension = pi.redactForUpload(input).text;
		const viaShare = redactShareText(input, currentShareRedactionContext(), new Map());

		expect(viaExtension).toBe(viaShare);
	});

	it("reports the running senpi version to extensions", async () => {
		const pi = await extensionApi();
		const { VERSION } = await import("../../../src/config.ts");

		expect(pi.hostVersion).toBe(VERSION);
	});
});
