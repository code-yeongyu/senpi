import type { OAuthAuth } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { listAccounts, SENTINEL_OAUTH_FIELDS } from "../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import { createOAuthConfig } from "../src/core/extensions/builtin/claude-sdk-oauth/oauth-login.ts";

function fakeFlow(credential: { access: string; refresh: string; expires: number }): OAuthAuth {
	return {
		name: "fake",
		async login() {
			return { type: "oauth", ...credential };
		},
		async refresh(current) {
			return current;
		},
		async toAuth(current) {
			return { apiKey: current.access };
		},
	};
}

const fresh = { access: "a1", refresh: "r1", expires: Date.now() + 60_000 };

describe("claude-sdk-oauth oauth login config", () => {
	it("offers the existing anthropic credential as an import before a fresh login", async () => {
		const config = createOAuthConfig({
			readCurrent: async () => undefined,
			readAnthropicCredential: async () => ({ access: "ia", refresh: "ir", expires: 1 }),
			loginFlow: fakeFlow(fresh),
		});
		const credential = await config.login({ onPrompt: async () => "y" });
		const slots = listAccounts(credential as never);
		expect(slots.map((slot) => slot.name)).toEqual(["imported-anthropic"]);
		expect(slots[0]?.source).toBe("import");
	});

	it("declining the import falls through to a fresh login without the import slot", async () => {
		const config = createOAuthConfig({
			readCurrent: async () => undefined,
			readAnthropicCredential: async () => ({ access: "ia", refresh: "ir", expires: 1 }),
			loginFlow: fakeFlow(fresh),
		});
		const prompts: string[] = [];
		const credential = await config.login({
			onPrompt: async (prompt) => {
				prompts.push(prompt.message);
				return prompts.length === 1 ? "n" : "work";
			},
		});
		const slots = listAccounts(credential as never);
		expect(slots.map((slot) => slot.name)).toEqual(["default"]);
		expect(slots.every((slot) => slot.source !== "import")).toBe(true);
	});

	it("second login adds a prompted account name without dropping slots", async () => {
		const existing = await createOAuthConfig({
			readCurrent: async () => undefined,
			loginFlow: fakeFlow(fresh),
		}).login({});
		const config = createOAuthConfig({
			readCurrent: async () => existing as never,
			loginFlow: fakeFlow({ access: "a2", refresh: "r2", expires: Date.now() + 60_000 }),
		});
		const credential = await config.login({ onPrompt: async () => "work" });
		const slots = listAccounts(credential as never);
		expect(slots.map((slot) => slot.name)).toEqual(["default", "work"]);
		expect(slots[1]?.access).toBe("a2");
	});

	it("keeps sentinel top-level fields and sentinel getApiKey", async () => {
		const config = createOAuthConfig({ readCurrent: async () => undefined, loginFlow: fakeFlow(fresh) });
		const credential = await config.login({});
		expect((credential as { access: string }).access).toBe(SENTINEL_OAUTH_FIELDS.access);
		expect(config.getApiKey(credential)).toBe(SENTINEL_OAUTH_FIELDS.access);
	});

	it("passes a concrete abort signal to the provider login flow", async () => {
		const controller = new AbortController();
		let receivedSignal: AbortSignal | undefined;
		const loginFlow: OAuthAuth = {
			name: "signal-probe",
			async login(interaction) {
				receivedSignal = interaction.signal;
				return { type: "oauth", ...fresh };
			},
			async refresh(current) {
				return current;
			},
			async toAuth(current) {
				return { apiKey: current.access };
			},
		};
		const config = createOAuthConfig({ readCurrent: async () => undefined, loginFlow });

		await config.login({ signal: controller.signal });

		expect(receivedSignal).toBe(controller.signal);
	});

	it("refreshToken is a preserving no-op", async () => {
		const config = createOAuthConfig({ readCurrent: async () => undefined, loginFlow: fakeFlow(fresh) });
		const credential = await config.login({});
		expect(await config.refreshToken(credential)).toBe(credential);
	});
});
