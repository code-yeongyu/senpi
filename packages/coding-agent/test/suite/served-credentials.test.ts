import { type AssistantMessage, fauxAssistantMessage, type ProviderDiagnosticCategory } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	CREDENTIAL_SERVED_WINDOW_MS,
	type RequestCredential,
	ServedCredentials,
} from "../../src/core/served-credentials.ts";

const credential: RequestCredential = { provider: "faux", baseUrl: "https://example.invalid", apiKey: "test-key" };

function failed(category: ProviderDiagnosticCategory = "auth"): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error" }),
		providerDiagnostic: { category, httpStatus: 401, evidence: "structured_status" },
	};
}

async function observe(table: ServedCredentials, message: AssistantMessage, key = credential): Promise<void> {
	await table.observe(Promise.resolve(message), key);
}

// senpi#2491: protect the inclusive freshness window, auth-only marking, and bounded storage.
// The existing session regression has no injected clock and never rotates enough keys to evict one.
describe("served credentials", () => {
	it.each([
		[0, "auth", true],
		[CREDENTIAL_SERVED_WINDOW_MS, "auth", true],
		[CREDENTIAL_SERVED_WINDOW_MS + 1, "auth", undefined],
		[1, "quota", undefined],
		[1, "unknown", undefined],
		[1, "network", undefined],
	] as const)("at age %i marks %s as %s", async (age, category, expected) => {
		let now = 0;
		const table = new ServedCredentials(() => now);
		await observe(table, fauxAssistantMessage("served"));
		now = age;
		const message = failed(category);
		await observe(table, message);
		expect(message.credentialServedRecently).toBe(expected);
	});

	it.each([
		{ ...credential, provider: "other" },
		{ ...credential, baseUrl: "https://other.invalid" },
		{ ...credential, apiKey: "rotated-key" },
	])("does not share success with %o", async (other) => {
		const table = new ServedCredentials(() => 0);
		await observe(table, fauxAssistantMessage("served"));
		const message = failed();
		await observe(table, message, other);
		expect(message.credentialServedRecently).toBeUndefined();
	});

	it("ignores a stream that settles without a final message", async () => {
		let now = 0;
		const table = new ServedCredentials(() => now);
		await expect(table.observe(Promise.resolve(undefined), credential)).resolves.toBeUndefined();
		now = 1;
		const message = failed();
		await observe(table, message);
		expect(message.credentialServedRecently).toBeUndefined();
	});

	it("does not renew the window on a failure", async () => {
		let now = 0;
		const table = new ServedCredentials(() => now);
		await observe(table, fauxAssistantMessage("served"));
		now = CREDENTIAL_SERVED_WINDOW_MS;
		await observe(table, failed());
		now += 1;
		const message = failed();
		await observe(table, message);
		expect(message.credentialServedRecently).toBeUndefined();
	});

	it.each(["record", "check"] as const)("prunes expired records on %s", async (operation) => {
		let now = 0;
		const table = new ServedCredentials(() => now);
		await observe(table, fauxAssistantMessage("served"));
		now = CREDENTIAL_SERVED_WINDOW_MS + 1;
		await observe(table, operation === "record" ? fauxAssistantMessage("served again") : failed(), {
			...credential,
			apiKey: "new-key",
		});
		// Memory retention is the contract here; observing an expired mark alone cannot detect a leak.
		expect(table).toHaveProperty("servedAt.size", operation === "record" ? 1 : 0);
	});

	it("caps retained credentials and evicts the least recently served first", async () => {
		let now = 0;
		const table = new ServedCredentials(() => now);
		const key = (id: number) => ({ ...credential, apiKey: `test-key-${id}` });
		for (let id = 0; id < 1_024; id++) await observe(table, fauxAssistantMessage("served"), key(id));
		now = 1;
		await observe(table, fauxAssistantMessage("served again"), key(0));
		await observe(table, fauxAssistantMessage("served"), key(1_024));
		const evicted = failed();
		const refreshed = failed();
		const newest = failed();
		await observe(table, evicted, key(1));
		await observe(table, refreshed, key(0));
		await observe(table, newest, key(1_024));
		expect(evicted.credentialServedRecently).toBeUndefined();
		expect(refreshed.credentialServedRecently).toBe(true);
		expect(newest.credentialServedRecently).toBe(true);
		expect(table).toHaveProperty("servedAt.size", 1_024);
	});
});
