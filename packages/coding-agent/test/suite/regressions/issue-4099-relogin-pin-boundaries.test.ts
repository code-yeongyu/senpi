import type { Api, Model } from "@earendil-works/pi-ai";
import { mergeRefreshedSlot, type PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { credentialRecoveryRevision } from "../../../src/core/credential-recovery-revision.ts";
import { RetryFallbackController } from "../../../src/core/retry-fallback/controller.ts";
import { SelectorCooldowns } from "../../../src/core/retry-fallback/cooldown.ts";

function model(provider: string, id: string): Model<Api> {
	return { ...getModel("anthropic", "claude-opus-4-5"), provider, id };
}

const original = model("anthropic-subscription", "claude-fable-5-1");
const fallback = model("kimi-coding", "kimi-k3");
const models = [original, fallback];
const billing = { errorMessage: '429 {"error":{"type":"usage_not_included","message":"not in your plan"}}' };

function createController() {
	let current: { model: Model<Api> } = { model: original };
	const login = { id: "login-a", reads: 0 };
	const controller = new RetryFallbackController({
		getSettings: () => ({ modelFallback: true, chains: { "anthropic-subscription/claude-fable-5-1": ["kimi-coding/kimi-k3"] } }),
		registry: {
			find: (provider, id) => models.find((entry) => entry.provider === provider && entry.id === id),
			getAll: () => models,
		},
		cooldowns: new SelectorCooldowns(() => 0),
		logger: { debug: () => {}, info: () => {}, warn: () => {} },
		switchModel: async (next) => {
			current = { model: next };
		},
		emit: () => {},
		getCurrentSelector: () => current,
		isAuthAvailable: () => true,
		recoveryRevision: async () => {
			login.reads++;
			return login.id;
		},
	});
	return { controller, login, current: () => current.model.id };
}

describe("the senpi#4099 pin release fires only on a sign-in at a turn boundary", () => {
	it("keeps a refusal pin after the original's account signs in again", async () => {
		const { controller, login, current } = createController();
		await controller.tryFallback("refusal", { errorMessage: "the model refused this request" });
		login.id = "login-b";

		expect(await controller.maybeRestorePrimary("cooldown-expiry", "turn")).toBe(false);
		expect({ model: current(), pinned: controller.activeState?.pinned }).toEqual({ model: "kimi-k3", pinned: true });
	});

	it("never releases a billing pin at a continuation boundary, only at the next turn", async () => {
		const { controller, login, current } = createController();
		await controller.tryFallback("billing", billing);
		expect(controller.activeState?.pinnedByBilling).toBe(true);
		login.id = "login-b";

		expect(await controller.maybeRestorePrimary("cooldown-expiry", "continuation")).toBe(false);
		expect({ model: current(), pinned: controller.activeState?.pinned }).toEqual({ model: "kimi-k3", pinned: true });
		expect(await controller.maybeRestorePrimary("cooldown-expiry", "turn")).toBe(true);
		expect(current()).toBe("claude-fable-5-1");
	});

	it("keeps a billing pin when the stored login id disappears instead of changing", async () => {
		const { controller, login } = createController();
		await controller.tryFallback("billing", billing);
		login.id = "";

		expect(await controller.maybeRestorePrimary("cooldown-expiry", "turn")).toBe(false);
		expect(controller.activeState?.pinned).toBe(true);
	});

	it("reads the store per turn only while a billing pin holds", async () => {
		const { controller, login } = createController();
		await controller.tryFallback("hard-error", { errorMessage: "HTTP 500: internal_error" });
		const readsAtEpisodeStart = login.reads;

		await controller.maybeRestorePrimary("never", "turn");
		await controller.maybeRestorePrimary("never", "turn");

		expect(login.reads).toBe(readsAtEpisodeStart);
	});
});

describe("credentialRecoveryRevision", () => {
	it("moves on a sign-in and holds across a token refresh of the same account", async () => {
		const storage = AuthStorage.inMemory();
		const oauth = (access: string, expires: number) => ({ type: "oauth" as const, access, refresh: `${access}-r`, expires });
		storage.set("synthetic", oauth("first", 1));
		storage.set("synthetic", oauth("second", 1));
		const signedIn = await credentialRecoveryRevision(storage, "synthetic");

		await storage.modify("synthetic", async (current) =>
			current ? mergeRefreshedSlot(current as PooledCredential, "default", oauth("rotated", 2)) : current,
		);
		const refreshed = await credentialRecoveryRevision(storage, "synthetic");
		storage.set("synthetic", oauth("third", 1));
		const signedInAgain = await credentialRecoveryRevision(storage, "synthetic");

		expect(signedIn).toMatch(/^[0-9a-f-]{36}$/);
		expect(refreshed).toBe(signedIn);
		expect(signedInAgain).not.toBe(signedIn);
	});
});
