import { readFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type PromptPresetSettings,
	resolvePreset,
	resolvePresetName,
} from "../../src/core/extensions/builtin/prompt-preset/presets.ts";

const AUTO: PromptPresetSettings = { promptPreset: "auto" };

function createModel(id: string, provider: string, api: Api = "anthropic-messages"): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
	};
}

// Ids from the Kimi Code model docs (k3.1-pro, k3.1-pro-highspeed) and the Kimi API
// quickstart (kimi-k3.1-pro, kimi-k3.1-pro-highspeed), both checked 2026-10-24.
describe("Kimi K3.1 prompt preset", () => {
	it.each([
		{ id: "k3.1-pro", provider: "kimi-coding" },
		{ id: "k3.1-pro-highspeed", provider: "kimi-coding" },
		{ id: "kimi-k3.1-pro", provider: "moonshotai" },
		{ id: "kimi-k3.1-pro-highspeed", provider: "moonshotai-cn" },
		{ id: "moonshotai/kimi-k3.1-pro", provider: "openrouter" },
		{ id: "Kimi K3.1 Pro", provider: "custom" },
	])("resolves $provider/$id to the kimi-k3-1 preset", ({ id, provider }) => {
		const preset = resolvePreset(createModel(id, provider), AUTO);

		expect(preset?.name).toBe("kimi-k3-1");
		expect(preset?.prompt).toContain("running on Kimi K3.1.");
	});

	it.each([
		{ id: "k3", provider: "kimi-coding" },
		{ id: "kimi-k3", provider: "moonshotai" },
		{ id: "moonshotai/kimi-k3", provider: "openrouter" },
	])("keeps $provider/$id on the kimi-k3 preset", ({ id, provider }) => {
		const preset = resolvePreset(createModel(id, provider), AUTO);

		expect(preset?.name).toBe("kimi-k3");
		expect(preset?.prompt).not.toContain("running on Kimi K3.1");
	});

	it.each(["kimi-k3-128k", "k31", "kimi-k2.8"])("does not route %s to the kimi-k3-1 preset", (id) => {
		expect(resolvePresetName(createModel(id, "moonshot"), AUTO)).not.toBe("kimi-k3-1");
	});

	it("allows settings.json to force kimi-k3-1", () => {
		const preset = resolvePreset(createModel("some-random-model", "custom"), { promptPreset: "kimi-k3-1" });

		expect(preset?.name).toBe("kimi-k3-1");
	});

	it("renders its own copy of the K3 template rather than delegating to it", () => {
		const presetDir = new URL("../../src/core/extensions/builtin/prompt-preset/", import.meta.url);
		const k31Source = readFileSync(new URL("kimi-k3-1.ts", presetDir), "utf8");
		const k3 = resolvePreset(createModel("kimi-k3", "moonshotai"), AUTO);
		const k31 = resolvePreset(createModel("kimi-k3.1-pro", "moonshotai"), AUTO);

		// Q (2026-10-24): K3.1 owns a copy, so a later K3 edit never reaches it; importing kimi-k3.ts breaks that.
		expect(k31Source).not.toMatch(/from "\.\/kimi-k3\.ts"/);
		expect(k31?.prompt).not.toBe(k3?.prompt);
	});
});
