import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listRotationSlots } from "../../../src/core/credential-pool/rotation-slots.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";
import { ModelConfig } from "../../../src/core/model-config.ts";
import { composeApiKeyAuth } from "../../../src/core/provider-api-key-auth.ts";
import { resolveConfiguredModelHeaders } from "../../../src/core/provider-composer.ts";
import { ROTATED, referenceRoot, SECRET } from "./3858-reference-support.ts";

const model: Model<"openai-completions"> = {
	id: "m",
	name: "m",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};
const input = () => ({
	ctx: { env: async () => undefined, fileExists: async () => false },
	signal: new AbortController().signal,
});

describe("model reference integration (#3858)", () => {
	let files: ReturnType<typeof referenceRoot>;
	beforeEach(() => {
		files = referenceRoot();
	});
	afterEach(() => {
		files.close();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("rotates provider and model headers without rewriting their declarations", async () => {
		const key = files.file("key");
		const content = JSON.stringify({
			providers: {
				fixture: {
					apiKey: { $file: "./key" },
					headers: { "X-Provider": { $file: "./key" } },
					models: [{ id: "m", headers: { "X-Model": { $concat: ["Bearer ", { $file: "./key" }] } } }],
					modelOverrides: { m: { headers: { "X-Override": { $file: "./key" } } } },
				},
			},
		});
		const path = files.file("custom-models.json", content);
		const config = await ModelConfig.load(path);
		expect(config.getError()).toBeUndefined();
		const provider = config.getProvider("fixture");
		const auth = composeApiKeyAuth("fixture", undefined, provider, undefined);
		for (const value of [SECRET, ROTATED]) {
			writeFileSync(key, value);
			expect(await auth?.resolve(input())).toMatchObject({
				auth: { apiKey: value, headers: { "X-Provider": value } },
			});
			expect(await resolveConfiguredModelHeaders(model, provider, undefined)).toEqual({
				"X-Model": `Bearer ${value}`,
				"X-Override": value,
			});
		}
		expect(readFileSync(path, "utf8")).toBe(content);
	});

	it("does not replace an absent request environment with ambient process credentials", async () => {
		vi.stubEnv("REQUEST_3858", SECRET);
		const path = files.file(
			"models.json",
			JSON.stringify({ providers: { fixture: { apiKey: { $env: "REQUEST_3858" } } } }),
		);
		const config = await ModelConfig.load(path);
		const auth = composeApiKeyAuth("fixture", undefined, config.getProvider("fixture"), undefined);
		await expect(auth?.resolve(input())).rejects.toMatchObject({
			name: "ConfigReferenceError",
			reason: "unset",
		});
	});

	it("rejects extension model references before reading the provider key", async () => {
		const path = files.file(
			"models.json",
			JSON.stringify({ providers: { fixture: { apiKey: { $file: "./missing" } } } }),
		);
		const config = await ModelConfig.load(path);
		const invoke = async () => {
			const auth = Reflect.apply(composeApiKeyAuth, undefined, [
				"fixture",
				undefined,
				config.getProvider("fixture"),
				{ models: [{ id: "m", headers: { Authorization: { $file: "./forbidden" } } }] },
			]);
			return auth?.resolve(input());
		};
		await expect(invoke()).rejects.toMatchObject({ name: "ConfigReferenceError", reason: "forbidden" });
	});

	it.each([false, true])("keeps healthy policy slots usable (broken sibling=%s)", async (missing) => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const path = files.file(
			"models.json",
			JSON.stringify({
				providers: {
					fixture: {
						credentials: {
							slots: {
								chosen: { value: { $env: "SLOT" } },
								...(missing ? { broken: { value: { $file: "./missing" } } } : {}),
							},
						},
					},
				},
			}),
		);
		const config = await ModelConfig.load(path);
		expect(config.getError()).toBeUndefined();
		const result = listRotationSlots(
			{
				providerId: "fixture",
				credential: undefined,
				env: (name) => (name === "SLOT" ? SECRET : undefined),
				repository: new CredentialSlotRepository(join(files.root, "health.json")),
				policy: config.getProvider("fixture")?.credentials,
			},
			{ acquireLeases: false },
		);
		expect(await result).toMatchObject([{ name: "chosen", envKey: SECRET }]);
		// Every request lists the slots; a broken unused slot warns once per field, not once per turn.
		await listRotationSlots(
			{
				providerId: "fixture",
				credential: undefined,
				env: (name) => (name === "SLOT" ? SECRET : undefined),
				repository: new CredentialSlotRepository(join(files.root, "health.json")),
				policy: config.getProvider("fixture")?.credentials,
			},
			{ acquireLeases: false },
		);
		if (missing) {
			expect(warning).toHaveBeenCalledTimes(1);
			expect(warning).toHaveBeenCalledWith(
				expect.stringContaining(
					"providers.fixture.credentials.slots.broken.value: configuration reference missing",
				),
			);
			expect(JSON.stringify(warning.mock.calls)).not.toContain(SECRET);
		} else expect(warning).not.toHaveBeenCalled();
	});

	it("fails with a named error when every policy slot is broken", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const path = files.file(
			"models.json",
			JSON.stringify({
				providers: {
					fixture: { credentials: { slots: { broken: { value: { $file: "./missing" } } } } },
				},
			}),
		);
		const config = await ModelConfig.load(path);
		await expect(
			listRotationSlots(
				{
					providerId: "fixture",
					credential: undefined,
					env: () => undefined,
					repository: new CredentialSlotRepository(join(files.root, "health.json")),
					policy: config.getProvider("fixture")?.credentials,
				},
				{ acquireLeases: false },
			),
		).rejects.toMatchObject({
			name: "ConfigReferenceError",
			field: "providers.fixture.credentials.slots.broken.value",
			reason: "missing",
		});
	});
});
