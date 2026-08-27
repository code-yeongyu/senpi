import { describe, expect, test } from "vitest";
import { InMemoryCredentialStore } from "../../ai/src/auth/credential-store.ts";
import { envApiKeyAuth } from "../../ai/src/auth/helpers.ts";
import { resolveProviderAuth } from "../../ai/src/auth/resolve.ts";
import { discoverEnvSlots, primaryEnvVar } from "../src/core/credential-pool/env-slots.ts";

function envFrom(values: Record<string, string>): (name: string) => string | undefined {
	return (name) => values[name];
}

describe("numbered env credential slots", () => {
	test("OPENAI_API_KEY plus OPENAI_API_KEY_2 yield a two-slot pool", () => {
		const slots = discoverEnvSlots("openai", envFrom({ OPENAI_API_KEY: "sk-one", OPENAI_API_KEY_2: "sk-two" }));
		expect(slots).toEqual([
			{ name: "env", envVarName: "OPENAI_API_KEY", key: "sk-one", source: "env" },
			{ name: "env-2", envVarName: "OPENAI_API_KEY_2", key: "sk-two", source: "env" },
		]);
	});

	test("a numbering gap is tolerated without inventing slots", () => {
		const slots = discoverEnvSlots("openai", envFrom({ OPENAI_API_KEY_3: "sk-three" }));
		expect(slots).toEqual([{ name: "env-3", envVarName: "OPENAI_API_KEY_3", key: "sk-three", source: "env" }]);
	});

	test("anthropic numbered slots extend the API-key var, not the token vars", () => {
		expect(primaryEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
	});

	test("an unmapped provider yields no env slots", () => {
		expect(discoverEnvSlots("no-such-provider", envFrom({ NO_SUCH_PROVIDER_API_KEY: "x" }))).toEqual([]);
	});

	test("a stored credential still outranks every env slot at resolution", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("envtest", async () => ({ type: "api_key", key: "stored-key" }));
		const provider = {
			id: "envtest",
			auth: { apiKey: envApiKeyAuth("Env Test API key", ["ENVTEST_API_KEY"]) },
		};
		const authContext = {
			env: async (name: string) => ({ ENVTEST_API_KEY: "env-key", ENVTEST_API_KEY_2: "env-key-2" })[name],
			fileExists: async () => false,
		};

		const resolved = await resolveProviderAuth(provider, store, authContext);

		expect(resolved?.auth.apiKey).toBe("stored-key");
	});
});
