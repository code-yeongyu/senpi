import { describe, expect, it } from "vitest";
import { lazyApi } from "../src/api/lazy.ts";
import { getModel } from "../src/compat.ts";
import { TURN_RETRY_SUPPRESSION_PREFIX } from "../src/utils/provider-failure-description.ts";

import { normalizeContext } from "../src/utils/transcript.ts";

// #2358: a package manager rewrote the install under a running session, so the provider module
// the session imports lazily is gone. Every fallback model needs a module from the same install.
async function failedLoadMessage(error: Error): Promise<string | undefined> {
	const api = lazyApi(async () => {
		throw error;
	});
	const model = getModel("openai", "gpt-4o-mini");
	return (await api.stream(model, normalizeContext({ messages: [] })).result()).errorMessage;
}

describe("a provider module that disappeared with the install (#2358)", () => {
	it.each([
		[
			"Node",
			"Cannot find module '/g/node_modules/@code-yeongyu/senpi/dist/bundle/chunks/anthropic-messages-UYDVRFAS.js' imported from /g/chunk-T3JBT2IK.js",
		],
		[
			"Bun resolution",
			"Cannot find module './anthropic-messages-UYDVRFAS.js' from '/g/dist/bundle/chunks/chunk-T3JBT2IK.js'",
		],
		["Bun read", 'ENOENT reading "/g/dist/bundle/chunks/anthropic-messages-UYDVRFAS.js"'],
	])("ends the turn with a restart notice and no retry under %s", async (_runtime, message) => {
		// Given / When
		const errorMessage = await failedLoadMessage(new Error(message));
		// Then
		expect(errorMessage?.startsWith(TURN_RETRY_SUPPRESSION_PREFIX)).toBe(true);
		expect(errorMessage).toContain("anthropic-messages-UYDVRFAS.js can no longer be loaded");
		expect(errorMessage).toContain("Restart");
	});

	it.each([
		["a missing dependency package", "Cannot find module 'some-sdk' imported from /g/chunk.js"],
		["a TypeScript source module", "Cannot find module './anthropic-messages.ts' from '/repo/src/api/lazy.ts'"],
		["an unrelated failure", "No API key for provider openai"],
	])("keeps %s verbatim and retryable", async (_kind, message) => {
		// Given / When
		const errorMessage = await failedLoadMessage(new Error(message));
		// Then
		expect(errorMessage).toBe(message);
	});
});
