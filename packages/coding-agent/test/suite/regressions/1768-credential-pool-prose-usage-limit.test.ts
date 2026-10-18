import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import {
	CREDENTIAL_POOL_STATE_FILENAME,
	CredentialSlotRepository,
} from "../../../src/core/credential-pool/state-store.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";

// senpi#1768: a subscription usage limit that reaches the pool as text alone,
// with no HTTP status, must block the spent account and move the request to
// the next one, through the same ModelRuntime path every session uses.

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "issue-1768-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function twoAccounts(): PooledCredential {
	return {
		type: "api_key",
		key: "key-default",
		accounts: [
			{ name: "default", key: "key-default", source: "login" },
			{ name: "work", key: "key-work", source: "login" },
		],
	};
}

async function runtimeWith(credential: PooledCredential | { type: "api_key"; key: string }) {
	const faux = fauxProvider();
	const credentials = AuthStorage.inMemory();
	await credentials.modify("faux", async () => credential);
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		agentDir: dir,
		allowModelNetwork: false,
	});
	await runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false, providers: ["faux"] });
	return { faux, runtime };
}

function usageLimit(errorMessage: string) {
	return fauxAssistantMessage([], { stopReason: "error", errorMessage });
}

/** Reads to the terminal event, then closes so the pool's last state write settles before teardown. */
async function collectClosed(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
		if (event.type === "done" || event.type === "error") break;
	}
	return events;
}

function poolState() {
	return new CredentialSlotRepository(join(dir, CREDENTIAL_POOL_STATE_FILENAME)).listSlots("faux", "stored");
}

describe("senpi#1768 prose usage limit through the credential pool", () => {
	test.each([
		["Codex SSE error", "Codex error: The usage limit has been reached"],
		["ChatGPT friendly message", "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min."],
		["Claude session limit", "You've hit your session limit \u00b7 resets 12am (Asia/Seoul)"],
	] as const)("%s on the first account: the request is retried on the second and succeeds", async (_label, text) => {
		const { faux, runtime } = await runtimeWith(twoAccounts());
		faux.setResponses([usageLimit(text), fauxAssistantMessage("served by the sibling")]);

		const events = await collectClosed(
			runtime.stream(faux.getModel(), { messages: [], tools: [] }, { sessionId: "issue-1768" }),
		);

		expect(events.at(-1)?.type).toBe("done");
		expect(faux.getCallLog()).toHaveLength(2);
		const state = await poolState();
		const blocked = Object.entries(state).filter(([, slot]) => slot.blockReason !== undefined);
		expect(blocked).toHaveLength(1);
		expect(blocked[0]?.[1]).toMatchObject({ blockReason: "rate_limit" });
		expect(blocked[0]?.[1].blockedUntil).toBeGreaterThan(Date.now());
	});

	test("a reset hours away cools that account until then and still serves the request from the sibling now", async () => {
		const { faux, runtime } = await runtimeWith(twoAccounts());
		faux.setResponses([
			usageLimit("You've hit your session limit \u00b7 resets in 3 hours"),
			fauxAssistantMessage("served by the sibling"),
		]);
		const before = Date.now();

		const events = await collectClosed(
			runtime.stream(faux.getModel(), { messages: [], tools: [] }, { sessionId: "issue-1768-reset" }),
		);

		expect(events.at(-1)?.type).toBe("done");
		expect(faux.getCallLog()).toHaveLength(2);
		const blocked = Object.values(await poolState()).filter((slot) => slot.blockReason === "rate_limit");
		expect(blocked).toHaveLength(1);
		const until = blocked[0]?.blockedUntil ?? 0;
		expect(until).toBeGreaterThanOrEqual(before + 3 * 3_600_000);
		expect(until).toBeLessThanOrEqual(Date.now() + 3 * 3_600_000);
	});

	test("every account spent: each is tried once and the provider's own error reaches the session", async () => {
		// The session's model fallback reads this terminal event; it must carry the
		// provider's text, not a generic pool message, so fallback behaves as before.
		const text = "Codex error: The usage limit has been reached";
		const { faux, runtime } = await runtimeWith(twoAccounts());
		faux.setResponses([usageLimit(text), usageLimit(text)]);

		const events = await collectClosed(
			runtime.stream(faux.getModel(), { messages: [], tools: [] }, { sessionId: "issue-1768-all" }),
		);

		expect(faux.getCallLog()).toHaveLength(2);
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		expect(terminal?.type === "error" ? terminal.error.errorMessage : undefined).toBe(text);
		const state = await poolState();
		expect(Object.values(state).map((slot) => slot.blockReason)).toEqual(["rate_limit", "rate_limit"]);
	});

	test("a single account never enters the pool: one attempt, the error goes to model fallback unchanged", async () => {
		const text = "Codex error: The usage limit has been reached";
		const { faux, runtime } = await runtimeWith({ type: "api_key", key: "key-default" });
		faux.setResponses([usageLimit(text)]);

		const events = await collectClosed(
			runtime.stream(faux.getModel(), { messages: [], tools: [] }, { sessionId: "issue-1768-one" }),
		);

		expect(faux.getCallLog()).toHaveLength(1);
		const terminal = events.at(-1);
		expect(terminal?.type === "error" ? terminal.error.errorMessage : undefined).toBe(text);
		expect(await poolState()).toEqual({});
	});
});
