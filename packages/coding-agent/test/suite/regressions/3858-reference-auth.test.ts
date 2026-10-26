import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProviderAuth } from "@earendil-works/pi-ai/auth/resolve";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage, ReadOnlyAuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelConfig } from "../../../src/core/model-config.ts";
import { composeApiKeyAuth } from "../../../src/core/provider-api-key-auth.ts";
import { RuntimeCredentials } from "../../../src/core/runtime-credentials.ts";
import { ROTATED, referenceRoot, SECRET } from "./3858-reference-support.ts";

describe("reference auth per-use resolution (#3858)", () => {
	let files: ReturnType<typeof referenceRoot>;
	beforeEach(() => {
		files = referenceRoot();
	});
	afterEach(() => files.close());

	it.each(["mutable", "readonly"] as const)("resolves %s auth without rewriting raw references", async (kind) => {
		const secretPath = files.file("key");
		const content = JSON.stringify({ fixture: { type: "api_key", key: { $file: secretPath } } });
		const path = files.file("auth.json", content);
		const store = kind === "mutable" ? AuthStorage.create(path) : new ReadOnlyAuthStorage(path);
		expect(await store.read("fixture")).toMatchObject({ key: SECRET });
		writeFileSync(secretPath, ROTATED);
		expect(await store.read("fixture")).toMatchObject({ key: ROTATED });
		expect(readFileSync(path, "utf8")).toBe(content);
	});

	it("retains custom model-config origin for relative keys and headers", async () => {
		files.file("key");
		const path = files.file(
			"custom.json",
			JSON.stringify({
				providers: {
					fixture: {
						apiKey: { $file: "./key" },
						headers: { "X-Credential": { $concat: ["Bearer ", { $file: "./key" }] } },
					},
				},
			}),
		);
		const config = await ModelConfig.load(path);
		expect(config.getError()).toBeUndefined();
		const auth = composeApiKeyAuth("fixture", undefined, config.getProvider("fixture"), undefined);
		expect(
			await auth?.resolve({
				ctx: { env: async () => undefined, fileExists: async () => false },
				signal: new AbortController().signal,
			}),
		).toMatchObject({ auth: { apiKey: SECRET, headers: { "X-Credential": `Bearer ${SECRET}` } } });
	});

	it("refuses extension overrides before any allowed sibling reference is read", async () => {
		const path = files.file(
			"models.json",
			JSON.stringify({ providers: { fixture: { apiKey: { $file: join(files.root, "missing") } } } }),
		);
		const config = await ModelConfig.load(path);
		const extension = { headers: { Authorization: { $file: join(files.root, "forbidden") } } };
		const invoke = async () => {
			const auth = Reflect.apply(composeApiKeyAuth, undefined, [
				"fixture",
				undefined,
				config.getProvider("fixture"),
				extension,
			]);
			return auth?.resolve({
				ctx: { env: async () => undefined, fileExists: async () => false },
				signal: new AbortController().signal,
			});
		};
		await expect(invoke()).rejects.toMatchObject({ name: "ConfigReferenceError", reason: "forbidden" });
	});

	it.each([false, true])(
		"resolves only the selected pool slot and never persists its projection (runtime overlay=%s)",
		async (overlay) => {
			const secretPath = files.file("selected");
			const content = JSON.stringify({
				fixture: {
					type: "api_key",
					key: { $file: join(files.root, "unused-flat") },
					accounts: [
						{ name: "good", key: { $file: secretPath } },
						{ name: "bad", key: { $file: join(files.root, "unused-slot") } },
					],
				},
			});
			const path = files.file("auth.json", content);
			const storage = AuthStorage.create(path);
			const result = await resolveProviderAuth(
				{
					id: "fixture",
					auth: {
						apiKey: {
							name: "Fixture",
							resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key } }),
						},
					},
				},
				overlay ? new RuntimeCredentials(storage) : storage,
				{ env: async () => undefined, fileExists: async () => false },
				{ slotName: "good" },
			);
			expect(result?.auth.apiKey).toBe(SECRET);
			expect(readFileSync(path, "utf8")).toBe(content);
		},
	);
});
