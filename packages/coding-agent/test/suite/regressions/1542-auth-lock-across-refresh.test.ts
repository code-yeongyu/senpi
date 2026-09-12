// #1542: the auth.json lock is not held across the OAuth token exchange, so two
// concurrent slot refreshes for one provider both complete and a third writer can
// take the lock while the (slow) exchange is in flight.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { CredentialStoreBusyError } from "../../../src/core/lockfile-policy.ts";

const PROVIDER_ID = "openai-codex";
const FUTURE = 4_102_444_800_000;

function deferred() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function pooled(): PooledCredential {
	return {
		type: "oauth",
		access: "a-access",
		refresh: "r-a",
		expires: 1,
		accounts: [
			{ name: "a", access: "a-access", refresh: "r-a", expires: 1, source: "login" },
			{ name: "b", access: "b-access", refresh: "r-b", expires: 1, source: "login" },
		],
	};
}

type Exchange = { started: ReturnType<typeof deferred>; gate: ReturnType<typeof deferred> };

function gatedProvider(exchanges: Map<string, Exchange>): Provider {
	return createProvider({
		id: PROVIDER_ID,
		name: "OpenAI Codex",
		baseUrl: "https://codex.example",
		auth: {
			oauth: {
				name: "OpenAI Codex OAuth",
				login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: FUTURE }),
				refresh: async (credential: OAuthCredential) => {
					const exchange = exchanges.get(credential.refresh);
					if (!exchange) throw new Error(`unexpected refresh token ${credential.refresh}`);
					exchange.started.resolve();
					await exchange.gate.promise;
					return {
						type: "oauth",
						access: `new-${credential.refresh}`,
						refresh: `${credential.refresh}-next`,
						expires: FUTURE,
					};
				},
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		models: [],
		api: "openai-responses" as never,
	});
}

describe("auth.json lock is released during the OAuth exchange (#1542)", () => {
	const tempDir = join(tmpdir(), `pi-test-1542-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const authPath = join(tempDir, "auth.json");

	beforeEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(authPath, JSON.stringify({ [PROVIDER_ID]: pooled() }));
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	it("two slot refreshes complete and a sibling writer takes the lock mid-exchange", async () => {
		const exchanges = new Map<string, Exchange>([
			["r-a", { started: deferred(), gate: deferred() }],
			["r-b", { started: deferred(), gate: deferred() }],
		]);
		const storage = AuthStorage.create(authPath);
		const models = createModels({ credentials: storage });
		models.setProvider(gatedProvider(exchanges));

		const refreshA = models.getAuth(PROVIDER_ID, { slotName: "a" });
		const refreshB = models.getAuth(PROVIDER_ID, { slotName: "b" });
		let siblingError: unknown;
		try {
			await exchanges.get("r-a")?.started.promise;

			// While slot "a" is at the provider, another process writes a third slot. The
			// sync lock budget is 1s, so a lock held across the exchange surfaces here as
			// CredentialStoreBusyError instead of a hang.
			const sibling = AuthStorage.create(authPath);
			try {
				sibling.setSlot(PROVIDER_ID, {
					name: "c",
					access: "c-access",
					refresh: "r-c",
					expires: FUTURE,
					source: "login",
				});
			} catch (error) {
				siblingError = error;
			}
		} finally {
			// Release both exchanges whatever happened above so no refresh outlives the temp dir.
			exchanges.get("r-a")?.gate.resolve();
			exchanges.get("r-b")?.gate.resolve();
		}
		expect(siblingError).toBeUndefined();

		const settled = await Promise.allSettled([refreshA, refreshB]);
		const busy = settled.filter(
			(result) =>
				result.status === "rejected" &&
				(result.reason instanceof CredentialStoreBusyError ||
					(result.reason as { cause?: unknown })?.cause instanceof CredentialStoreBusyError),
		);
		expect(busy).toEqual([]);
		expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
		const [a, b] = settled.map((result) => (result.status === "fulfilled" ? result.value : undefined));
		expect(a?.auth.apiKey).toBe("new-r-a");
		expect(b?.auth.apiKey).toBe("new-r-b");

		const stored = JSON.parse(readFileSync(authPath, "utf-8"))[PROVIDER_ID] as PooledCredential;
		const byName = new Map(stored.accounts?.map((slot) => [slot.name, slot]));
		expect(byName.get("a")).toMatchObject({ access: "new-r-a", refresh: "r-a-next" });
		expect(byName.get("b")).toMatchObject({ access: "new-r-b", refresh: "r-b-next" });
		expect(byName.get("c")).toMatchObject({ access: "c-access", refresh: "r-c" });
	});
});
