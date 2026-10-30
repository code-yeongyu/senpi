import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";

// senpi#4093: pool health was keyed to an HMAC over the slot's access and refresh
// tokens, so a routine OAuth refresh made every stored block inapplicable and the
// spent or disabled account was tried again. A verdict on the account must survive
// new token material; only a rejected-token verdict belongs to the token itself.

const PROVIDER = "chatgpt-subscription";
const START = Date.UTC(2026, 9, 30, 0, 0, 0);
const HOUR = 60 * 60_000;

let dir: string;
let repository: CredentialSlotRepository;
let clock = START;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "senpi-4093-pool-"));
	repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
	clock = START;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function pool(alphaAccess: string): PooledCredential {
	return {
		type: "oauth",
		access: "managed",
		refresh: "managed",
		expires: START + 30 * 24 * HOUR,
		accounts: [
			{ name: "alpha", access: alphaAccess, refresh: "alpha-refresh", source: "login" },
			{ name: "bravo", access: "bravo-access", refresh: "bravo-refresh", source: "login" },
		],
	};
}

function failure(status: number, message: string): Error {
	return Object.assign(new Error(message), { status });
}

async function* served(): AsyncGenerator<AssistantMessageEvent> {
	yield {
		type: "done",
		reason: "stop",
		message: {
			role: "assistant",
			content: [],
			api: "openai-codex-responses",
			provider: PROVIDER,
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: START,
		},
	};
}

async function request(alphaAccess: string, alphaFailure: Error | undefined, attempts: string[]): Promise<void> {
	const stream = streamWithCredentialRotation({
		sources: {
			providerId: PROVIDER,
			credential: pool(alphaAccess),
			env: () => undefined,
			repository,
			policy: { affinity: false },
			now: () => clock,
		},
		runAttempt: (slot) => {
			attempts.push(slot.name);
			if (slot.name === "alpha" && alphaFailure !== undefined) throw alphaFailure;
			return served();
		},
	});
	for await (const _event of stream) {
		// drain
	}
}

describe("senpi#4093: an account's block survives a refresh of its token", () => {
	it.each([
		["a billing block", failure(402, "Payment required")],
		["a usage-limit block", failure(429, "You have hit your ChatGPT usage limit. Try again in ~3 hours.")],
	])(
		"#given %s on alpha #when alpha's access token is refreshed #then the next request skips alpha",
		async (_label, verdict) => {
			const attempts: string[] = [];
			await request("alpha-access-1", verdict, attempts);

			clock += 10 * 60_000;
			await request("alpha-access-2", undefined, attempts);

			expect(attempts).toEqual(["alpha", "bravo", "bravo"]);
		},
	);

	it("#given a billing block on alpha #when the user logs alpha in again #then the login clears the block", async () => {
		const attempts: string[] = [];
		await request("alpha-access-1", failure(402, "Payment required"), attempts);

		const storage = AuthStorage.create(join(dir, "auth.json"));
		storage.set(PROVIDER, pool("alpha-access-1"));
		const relogin: OAuthCredential = {
			...pool("alpha-access-2"),
			accounts: [
				{
					name: "alpha",
					access: "alpha-access-2",
					refresh: "alpha-refresh-2",
					expires: START + 60 * 24 * HOUR,
					source: "login",
				},
			],
		} as OAuthCredential;
		const oauth: OAuthAuth = {
			name: "fake",
			login: async () => relogin,
			refresh: async (current) => current,
			toAuth: async (current) => ({ apiKey: current.access }),
		};
		storage.registerOAuthProvider(PROVIDER, oauth);
		await storage.login(PROVIDER, { onAuth: () => {}, onPrompt: async () => "" } as never);

		expect((await repository.listSlots(PROVIDER, "stored")).alpha).toBeUndefined();
	});

	it("#given a rejected-token block on alpha #when alpha's token is replaced #then alpha is tried again at once", async () => {
		const attempts: string[] = [];
		await request("alpha-access-1", failure(401, "invalid_token"), attempts);

		clock += 60_000;
		await request("alpha-access-2", undefined, attempts);

		expect(attempts).toEqual(["alpha", "bravo", "alpha"]);
	});
});
