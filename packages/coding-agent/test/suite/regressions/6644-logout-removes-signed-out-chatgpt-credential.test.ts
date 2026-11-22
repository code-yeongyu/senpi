/**
 * senpi#6644: `/logout` of the ChatGPT entry leaves it listed. A full provider
 * logout of a revoke-capable OAuth provider revokes and clears tokens but the
 * credential entry must not survive as a stored sign-in: the `/logout` picker
 * (`listCredentials`), `get`/`has`/`hasAuth`, the auth.json on disk, and a
 * fresh store over that file (a restart) all report it gone. The credential
 * here sits under the legacy provider id `openai-codex`, as on an install
 * first signed in before the provider rename, with pooled slots on the
 * Sign-in-with-ChatGPT route.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";

const PROVIDER = "chatgpt-subscription";
const LEGACY_PROVIDER = "openai-codex";
const DISCOVERY = "https://auth.openai.com/.well-known/openid-configuration";
const REVOCATION = "https://auth.openai.com/oauth/revoke";

type SlotSpec = { name: string; access: string; refresh: string };

function pooledChatGptCredential(slots: SlotSpec[]) {
	const base = {
		type: "oauth" as const,
		route: "siwc" as const,
		expires: 2_600_000_000_000,
		clientId: "oaiapp_synthetic",
		hostId: "urn:uuid:e61bbe28-07ef-466d-8e5d-a344f94ab305",
	};
	return {
		...base,
		access: "flat-access",
		refresh: "flat-refresh",
		accounts: slots.map((slot) => ({
			...base,
			name: slot.name,
			access: slot.access,
			refresh: slot.refresh,
		})),
	};
}

function writeLegacyAuthJson(agentDir: string): void {
	// A pre-rename install: the ChatGPT credential is keyed by the legacy id,
	// pooled over two accounts, next to an unrelated API-key provider.
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify(
			{
				[LEGACY_PROVIDER]: pooledChatGptCredential([
					{ name: "work", access: "work-access", refresh: "work-refresh" },
					{ name: "personal", access: "personal-access", refresh: "personal-refresh" },
				]),
				"synthetic-key-provider": { type: "api_key", key: "synthetic-key" },
			},
			null,
			2,
		),
		{ encoding: "utf-8", mode: 0o600 },
	);
}

/** Offline revocation: discovery resolves, every revocation POST succeeds. */
function stubRevocationFetch(): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === DISCOVERY) return Response.json({ revocation_endpoint: REVOCATION });
			expect(url).toBe(REVOCATION);
			return new Response(null, { status: 200 });
		}),
	);
}

const agentDirs: string[] = [];

function makeAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "senpi-6644-"));
	agentDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.unstubAllGlobals();
	while (agentDirs.length > 0) {
		const dir = agentDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

describe("full /logout removes a signed-out ChatGPT credential (senpi#6644)", () => {
	it("a full logout deletes the retained registration: picker, reads, file, and a restart all report it gone", async () => {
		stubRevocationFetch();
		const agentDir = makeAgentDir();
		writeLegacyAuthJson(agentDir);
		const storage = AuthStorage.create(join(agentDir, "auth.json"));
		const runtime = await ModelRuntime.create({
			credentials: storage,
			modelsPath: null,
			allowModelNetwork: false,
			agentDir,
		});

		// The /logout picker's own source lists the ChatGPT entry before logout.
		expect((await runtime.listCredentials()).map((entry) => entry.providerId)).toContain(PROVIDER);

		const { revocation } = await runtime.logoutProvider(PROVIDER);
		expect(revocation?.status).toBe("revoked");

		// The storage surface: nothing reads the provider as signed in.
		expect(storage.get(PROVIDER)).toBeUndefined();
		expect(storage.has(PROVIDER)).toBe(false);
		expect(storage.hasAuth(PROVIDER)).toBe(false);

		// The /logout picker's source after logout.
		expect((await runtime.listCredentials()).map((entry) => entry.providerId)).not.toContain(PROVIDER);

		// The file on disk: neither spelling survives, the sibling provider does.
		const stored = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8")) as Record<string, unknown>;
		expect(stored[PROVIDER]).toBeUndefined();
		expect(stored[LEGACY_PROVIDER]).toBeUndefined();
		expect(stored["synthetic-key-provider"]).toEqual({ type: "api_key", key: "synthetic-key" });

		// A restart: a fresh store over the same file does not list it either.
		const restarted = AuthStorage.create(join(agentDir, "auth.json"));
		expect(restarted.get(PROVIDER)).toBeUndefined();
		expect(restarted.has(PROVIDER)).toBe(false);
		expect((await restarted.list()).map((entry) => entry.providerId)).not.toContain(PROVIDER);
	});

	it("a full logout retires the signed-out provider's slot health", async () => {
		stubRevocationFetch();
		const agentDir = makeAgentDir();
		writeLegacyAuthJson(agentDir);
		const statePath = join(agentDir, "credential-pool-state.json");
		const repository = new CredentialSlotRepository(statePath);
		await repository.mutateSlotState(PROVIDER, "stored", "work", () => ({
			blockReason: "auth_error",
			blockedUntil: 2_600_000_000_000,
		}));

		const storage = AuthStorage.create(join(agentDir, "auth.json"));
		const runtime = await ModelRuntime.create({
			credentials: storage,
			modelsPath: null,
			allowModelNetwork: false,
			agentDir,
		});
		await runtime.logoutProvider(PROVIDER);

		const health = await new CredentialSlotRepository(statePath).listSlots(PROVIDER, "stored");
		expect(health).toEqual({});
	});

	it("signing out one account keeps the provider and its signed-in siblings listed", async () => {
		stubRevocationFetch();
		const agentDir = makeAgentDir();
		writeLegacyAuthJson(agentDir);
		const storage = AuthStorage.create(join(agentDir, "auth.json"));
		const runtime = await ModelRuntime.create({
			credentials: storage,
			modelsPath: null,
			allowModelNetwork: false,
			agentDir,
		});

		const { revocation } = await runtime.logoutProvider(PROVIDER, { slotId: "work" });
		expect(revocation?.status).toBe("revoked");

		// The #5974 contract: one account signs out, the provider and its other
		// account stay signed in and listed.
		expect(storage.has(PROVIDER)).toBe(true);
		const credential = storage.get(PROVIDER);
		expect(credential?.type).toBe("oauth");
		if (credential?.type !== "oauth" || !Array.isArray(credential.accounts)) throw new Error("Missing pool");
		expect(credential.accounts).toMatchObject([
			{ name: "work", access: "", refresh: "" },
			{ name: "personal", access: "personal-access", refresh: "personal-refresh" },
		]);
	});
});

describe("AuthStorage mutation and lookup agree on legacy keys (senpi#6644)", () => {
	it("has, remove and removeSlot reach a credential stored under the legacy id", () => {
		const agentDir = makeAgentDir();
		writeLegacyAuthJson(agentDir);
		const storage = AuthStorage.create(join(agentDir, "auth.json"));
		// The load seam migrates plain-object entries; assert against what a
		// legacy entry that migration leaves alone (a non-object value) proves:
		// reads fall back to the legacy key, so has and remove must too.
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ [LEGACY_PROVIDER]: "unreadable-by-a-human-until-inspected" }, null, 2),
			{ encoding: "utf-8", mode: 0o600 },
		);
		const legacy = AuthStorage.create(join(agentDir, "auth.json"));

		expect(legacy.get(PROVIDER)).toBe("unreadable-by-a-human-until-inspected");
		expect(legacy.has(PROVIDER)).toBe(true);

		legacy.remove(PROVIDER);
		expect(legacy.get(PROVIDER)).toBeUndefined();
		expect(legacy.has(PROVIDER)).toBe(false);
		const stored = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8")) as Record<string, unknown>;
		expect(stored[LEGACY_PROVIDER]).toBeUndefined();
	});
});
