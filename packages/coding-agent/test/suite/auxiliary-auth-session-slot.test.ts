import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rendezvousOrder } from "@earendil-works/pi-ai/auth/pool/select";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { sha256SlotHasher } from "../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../src/core/credential-pool/state-store.ts";
import { resolveImageGenAuth } from "../../src/core/extensions/builtin/imagegen/auth.ts";
import { buildNativeEntries } from "../../src/core/extensions/builtin/websearch/websearch/native.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";

// Compaction, /btw, look-at and cache keepalive resolve auth through
// ModelRegistry.getApiKeyAndHeaders and then send that key directly, outside the
// rotation stream. Given the session id they must authenticate as the account the
// session's own turns use (the pin, else the session's rendezvous winner among
// unblocked accounts), never the flat projection and never a silent switch.

const FAR = 4_102_444_800_000;
let dir: string;
let storage: AuthStorage;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-slot-auth-"));
	storage = AuthStorage.create(join(dir, "auth.json"));
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown): Promise<Response> => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("/oauth/token")) {
				return new Response(
					JSON.stringify({ error: "invalid_grant", error_description: "Refresh token expired" }),
					{
						status: 400,
					},
				);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

type Material = { access: string; refresh: string; expires: number };
const slot = (tag: string, expires = FAR): Material => ({
	access: `${tag}-access`,
	refresh: `${tag}-refresh`,
	expires,
});

async function seed(accounts: Record<string, Material>, extra: { pinned?: string } = {}): Promise<void> {
	const [first] = Object.values(accounts);
	await storage.modify("anthropic", async () => ({
		type: "oauth",
		...first,
		accounts: Object.entries(accounts).map(([name, material]) => ({ name, source: "login", ...material })),
		...extra,
	}));
}

function registry(): ModelRegistry {
	return new ModelRegistry(
		ModelRuntime.createSync({ credentials: storage, modelsPath: null, agentDir: dir }),
		storage,
	);
}

function model(models: ModelRegistry) {
	const found = models.find("anthropic", "claude-sonnet-4-5");
	if (!found) throw new Error("expected the built-in claude-sonnet-4-5 model");
	return found;
}

function rank(sessionId: string, names: string[]): string | undefined {
	return rendezvousOrder(
		sessionId,
		names.map((name) => ({ name })),
		sha256SlotHasher,
	)[0]?.name;
}

function sessionWhere(predicate: (sessionId: string) => boolean): string {
	for (let i = 0; i < 10_000; i++) {
		if (predicate(`session-${i}`)) return `session-${i}`;
	}
	throw new Error("no session id satisfies the predicate");
}

/** A session id whose rendezvous winner over `names` is `wanted`. */
function sessionWinning(wanted: string, names: string[]): string {
	return sessionWhere((id) => rank(id, names) === wanted);
}

describe("auxiliary auth follows the session's account", () => {
	it("authenticates as the session's rendezvous winner, not the flat projection", async () => {
		await seed({ default: slot("first"), "login-2": slot("second") });
		const models = registry();

		const auth = await models.getApiKeyAndHeaders(model(models), {
			sessionId: sessionWinning("login-2", ["default", "login-2"]),
		});

		expect(auth).toMatchObject({ ok: true, apiKey: "second-access" });
	});

	it("uses the pinned account for every session", async () => {
		await seed({ default: slot("first"), "login-2": slot("second") }, { pinned: "login-2" });
		const models = registry();

		const auth = await models.getApiKeyAndHeaders(model(models), {
			sessionId: sessionWinning("default", ["default", "login-2"]),
		});

		expect(auth).toMatchObject({ ok: true, apiKey: "second-access" });
	});

	it("reports the session account's own failure instead of switching to another account", async () => {
		await seed({ default: slot("live"), "login-2": slot("dead", 1) });
		const models = registry();

		const auth = await models.getApiKeyAndHeaders(model(models), {
			sessionId: sessionWinning("login-2", ["default", "login-2"]),
		});

		expect(auth.ok).toBe(false);
		expect(auth.ok ? "" : auth.error).toContain("Refresh token expired");
	});

	it("follows the session onto the next account once its own account is blocked, as its turns do", async () => {
		await seed({ default: slot("first"), "login-2": slot("second"), "login-3": slot("third") });
		const sessionId = sessionWhere(
			(id) =>
				rank(id, ["default", "login-2", "login-3"]) === "login-2" && rank(id, ["default", "login-3"]) === "login-3",
		);
		const repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
		const revision = await repository.storedCredentialRevision("anthropic", "login-2", slot("second"));
		await repository.mutateSlotState("anthropic", "stored", "login-2", () => ({
			blockReason: "auth_error",
			credentialRevision: revision,
		}));
		const models = registry();

		const auth = await models.getApiKeyAndHeaders(model(models), { sessionId });

		expect(auth).toMatchObject({ ok: true, apiKey: "third-access" });
	});

	it("keeps the flat projection when no session is given", async () => {
		await seed({ default: slot("first"), "login-2": slot("second") });
		const models = registry();

		expect(await models.getApiKeyAndHeaders(model(models))).toMatchObject({ ok: true, apiKey: "first-access" });
	});
});

describe("builtin tools thread the session into auxiliary auth", () => {
	it("native web search resolves its route's key for the calling session", async () => {
		const calls: unknown[][] = [];
		const model = { id: "gpt-5", provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
		await buildNativeEntries(
			model,
			{
				getApiKeyAndHeaders: async (...args: unknown[]) => {
					calls.push(args);
					return { ok: true, apiKey: "key" };
				},
			},
			undefined,
			"session-websearch",
		);

		expect(calls).toEqual([[model, { sessionId: "session-websearch" }]]);
	});

	it("image generation resolves a gateway's key for the calling session", async () => {
		const calls: unknown[][] = [];
		const gateway = {
			id: "gpt-image-1",
			provider: "my-gateway",
			api: "openai-responses",
			baseUrl: "https://gateway.example.test/v1",
		};
		await resolveImageGenAuth({
			env: {},
			sessionId: "session-imagegen",
			modelRegistry: {
				authStorage: { get: () => undefined },
				getAll: () => [gateway],
				getApiKeyAndHeaders: async (...args: unknown[]) => {
					calls.push(args);
					return { ok: true, apiKey: "gateway-key" };
				},
				getProviderAuth: async () => undefined,
			},
		});

		expect(calls).toContainEqual([gateway, { sessionId: "session-imagegen" }]);
	});
});
