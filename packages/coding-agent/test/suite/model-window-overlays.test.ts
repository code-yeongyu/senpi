import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("extension model window configuration", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("keeps user-defined windows above overlays through refresh without writing models.json", async () => {
		const config = {
			providers: {
				faux: {
					baseUrl: "https://configured.invalid",
					models: [
						{ id: "custom", contextWindow: 42_000 },
						{ id: "both", contextWindow: 47_000 },
						{ id: "duplicate", contextWindow: 46_000 },
						{ id: "duplicate", contextWindow: 48_000 },
					],
					modelOverrides: { overridden: { contextWindow: 53_000 }, both: { contextWindow: 57_000 } },
				},
			},
		};
		const harness = await createHarness({
			models: [
				{ id: "ordinary", name: "Ordinary", contextWindow: 32_000 },
				{ id: "custom", name: "Custom", contextWindow: 32_000 },
				{ id: "both", name: "Both", contextWindow: 32_000 },
				{ id: "duplicate", name: "Duplicate", contextWindow: 32_000 },
				{ id: "overridden", name: "Overridden", contextWindow: 32_000 },
			],
			modelsJson: config,
			extensionFactories: [
				(pi) =>
					pi.setModelWindowOverrides("faux", {
						ordinary: 100_000,
						custom: 100_000,
						both: 100_000,
						duplicate: 100_000,
						overridden: 100_000,
					}),
			],
		});
		harnesses.push(harness);
		const path = `${harness.tempDir}/models.json`;
		const original = readFileSync(path, "utf8");
		const registry = harness.session.modelRegistry;

		expect(harness.session.model?.contextWindow).toBe(100_000);
		expect(registry.getAll().find((model) => model.id === "ordinary")?.contextWindow).toBe(100_000);
		const baseCatalog = registry.getAll({ includeWindowOverlays: false });
		expect(baseCatalog.find((model) => model.id === "ordinary")?.contextWindow).toBe(32_000);
		expect(baseCatalog.find((model) => model.id === "custom")?.contextWindow).toBe(42_000);
		expect(registry.find("faux", "ordinary")?.contextWindow).toBe(100_000);
		expect(registry.find("faux", "ordinary")?.baseUrl).toBe("https://configured.invalid");
		expect(registry.findOfType("chat", "faux", "ordinary")?.contextWindow).toBe(100_000);
		expect(registry.getModelOfType("chat", "faux", "ordinary")?.contextWindow).toBe(100_000);
		expect(registry.getModelsOfType("chat", "faux").find((entry) => entry.id === "ordinary")).toMatchObject({
			contextWindow: 100_000,
		});
		expect(
			(await registry.getAvailableOfType("chat", "faux")).find((entry) => entry.id === "ordinary"),
		).toMatchObject({
			contextWindow: 100_000,
		});
		expect(registry.find("faux", "custom")?.contextWindow).toBe(42_000);
		expect(registry.find("faux", "both")?.contextWindow).toBe(57_000);
		expect(registry.find("faux", "duplicate")?.contextWindow).toBe(48_000);
		expect(registry.find("faux", "overridden")?.contextWindow).toBe(53_000);
		await registry.refresh({ allowNetwork: false });
		expect(registry.find("faux", "ordinary")?.contextWindow).toBe(100_000);
		expect(registry.find("faux", "custom")?.contextWindow).toBe(42_000);
		expect(registry.find("faux", "both")?.contextWindow).toBe(57_000);
		expect(registry.find("faux", "duplicate")?.contextWindow).toBe(48_000);
		expect(registry.find("faux", "overridden")?.contextWindow).toBe(53_000);
		expect(readFileSync(path, "utf8")).toBe(original);

		config.providers.faux.models[0].contextWindow = 44_000;
		config.providers.faux.modelOverrides.overridden.contextWindow = 55_000;
		writeFileSync(path, JSON.stringify(config));
		const edited = readFileSync(path, "utf8");
		await registry.refresh({ allowNetwork: false });
		expect(registry.find("faux", "ordinary")?.contextWindow).toBe(100_000);
		expect(registry.find("faux", "custom")?.contextWindow).toBe(44_000);
		expect(registry.find("faux", "both")?.contextWindow).toBe(57_000);
		expect(registry.find("faux", "duplicate")?.contextWindow).toBe(48_000);
		expect(registry.find("faux", "overridden")?.contextWindow).toBe(55_000);
		expect(readFileSync(path, "utf8")).toBe(edited);

		writeFileSync(path, JSON.stringify({ providers: { faux: { baseUrl: config.providers.faux.baseUrl } } }));
		await registry.refresh({ allowNetwork: false });
		expect(registry.find("faux", "custom")?.contextWindow).toBe(100_000);
		expect(registry.find("faux", "both")?.contextWindow).toBe(100_000);
		expect(registry.find("faux", "duplicate")?.contextWindow).toBe(100_000);
		expect(registry.find("faux", "overridden")?.contextWindow).toBe(100_000);
		expect(registry.find("faux", "ordinary")?.baseUrl).toBe("https://configured.invalid");
	});

	it("isolates sessions and restores the preceding owner when an overlay is cleared", async () => {
		let first: ExtensionAPI | undefined;
		let second: ExtensionAPI | undefined;
		const a = await createHarness({
			models: [{ id: "fixture", name: "Fixture", contextWindow: 32_000 }],
			extensionFactories: [
				(pi) => {
					first = pi;
					const windows = { fixture: 100_000 };
					pi.setModelWindowOverrides("faux", windows);
					windows.fixture = 999_999;
				},
				(pi) => {
					second = pi;
					pi.setModelWindowOverrides("faux", { fixture: 200_000 });
				},
			],
		});
		harnesses.push(a);
		const b = await createHarness({ siblingOf: a });
		harnesses.push(b);
		const firstApi = first;
		const secondApi = second;
		if (!firstApi || !secondApi) throw new Error("Extension APIs were not registered");

		expect(a.session.modelRegistry.find("faux", "fixture")?.contextWindow).toBe(200_000);
		expect(b.session.modelRegistry.find("faux", "fixture")?.contextWindow).toBe(32_000);
		expect(a.session.model?.contextWindow).toBe(200_000);
		expect(() => secondApi.setModelWindowOverrides("faux", { fixture: -1 })).toThrow();
		expect(a.session.modelRegistry.find("faux", "fixture")?.contextWindow).toBe(200_000);
		secondApi.setModelWindowOverrides("faux", { another: 300_000 });
		expect(a.session.modelRegistry.find("faux", "fixture")?.contextWindow).toBe(100_000);
		secondApi.setModelWindowOverrides("faux", { fixture: 200_000 });
		secondApi.setModelWindowOverrides("faux", {});
		expect(a.session.modelRegistry.find("faux", "fixture")?.contextWindow).toBe(100_000);
		expect(a.session.model?.contextWindow).toBe(200_000);
		const next = a.session.modelRegistry.find("faux", "fixture");
		if (!next) throw new Error("Fixture model is missing");
		await a.session.setSessionModel(next);
		expect(a.session.model?.contextWindow).toBe(100_000);
		firstApi.setModelWindowOverrides("faux", {});
		expect(a.session.modelRegistry.find("faux", "fixture")?.contextWindow).toBe(32_000);
		expect(b.session.modelRegistry.find("faux", "fixture")?.contextWindow).toBe(32_000);
	});

	it("changes an active session's registry without writing models.json", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			models: [{ id: "fixture", name: "Fixture", contextWindow: 128_000 }],
			modelsJson: { providers: { faux: { baseUrl: "https://configured.invalid" } } },
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		if (!api) throw new Error("Extension API was not registered");
		const path = `${harness.tempDir}/models.json`;
		const before = readFileSync(path, "utf8");
		api.setModelWindowOverrides("faux", { fixture: 200_000 });
		expect(harness.session.modelRegistry.find("faux", "fixture")?.contextWindow).toBe(200_000);
		expect(harness.session.model?.contextWindow).toBe(128_000);
		expect(readFileSync(path, "utf8")).toBe(before);
		const projected = harness.session.modelRegistry.find("faux", "fixture");
		if (!projected) throw new Error("Fixture model is missing");
		await harness.session.setSessionModel(projected);
		expect(harness.session.model?.contextWindow).toBe(200_000);

		writeFileSync(
			path,
			JSON.stringify({
				providers: {
					faux: { baseUrl: "https://configured.invalid", modelOverrides: { fixture: { contextWindow: 140_000 } } },
				},
			}),
		);
		await harness.session.modelRegistry.refresh({ allowNetwork: false });
		const userModel = harness.session.modelRegistry.find("faux", "fixture");
		if (!userModel) throw new Error("Fixture model is missing after refresh");
		expect(userModel.contextWindow).toBe(140_000);
		expect(harness.session.model?.contextWindow).toBe(200_000);
		await harness.session.setSessionModel(userModel);
		expect(harness.session.model?.contextWindow).toBe(140_000);
	});
});
