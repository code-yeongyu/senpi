import { describe, expect, test } from "vitest";
import { CREDENTIAL_POLICY_DEFAULTS, validateModelsConfig } from "../src/core/model-config-schema.ts";

function config(credentials: unknown): unknown {
	return { providers: { openai: { credentials } } };
}

describe("models.json credentials policy schema", () => {
	test("defaults mirror the pool engine constants", () => {
		expect(CREDENTIAL_POLICY_DEFAULTS).toEqual({
			rotation: true,
			affinity: true,
			cooldownBaseMs: 60_000,
			cooldownCapMs: 172_800_000,
		});
	});

	test("a full valid policy block is accepted", () => {
		const valid = config({
			rotation: true,
			affinity: false,
			cooldownBaseMs: 30_000,
			cooldownCapMs: 3_600_000,
			slots: { work: { env: "OPENAI_API_KEY_2" }, personal: { value: "!op read op://vault/key" } },
		});
		expect(validateModelsConfig.Check(valid)).toBe(true);
	});

	test("a provider without a credentials block stays valid", () => {
		expect(validateModelsConfig.Check({ providers: { openai: {} } })).toBe(true);
	});

	test("a negative cooldown is rejected", () => {
		expect(validateModelsConfig.Check(config({ cooldownBaseMs: -1 }))).toBe(false);
	});

	test("an unknown key inside the policy block is rejected", () => {
		expect(validateModelsConfig.Check(config({ rotate: true }))).toBe(false);
	});

	test("a literal apiKey inside the policy block is rejected", () => {
		expect(validateModelsConfig.Check(config({ apiKey: "sk-secret" }))).toBe(false);
	});

	test("a slot reference with an unknown key is rejected", () => {
		expect(validateModelsConfig.Check(config({ slots: { work: { apiKey: "sk-secret" } } }))).toBe(false);
	});
});
