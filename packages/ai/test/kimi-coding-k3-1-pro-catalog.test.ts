import { describe, expect, it } from "vitest";
import { getBuiltinModel } from "../src/providers/all.ts";

// Kimi Code model configuration, https://www.kimi.com/code/docs/en/kimi-code/models.html (checked 2026-10-24):
// K3.1 Pro ships as `k3.1-pro` and `k3.1-pro-highspeed`, thinking only (low / high / max), up to 1048576
// context, image and video input. A mistyped id silently falls back to K2.8 Preview without thinking.
describe("kimi-coding K3.1 Pro catalog rows", () => {
	it.each([
		["k3.1-pro", "Kimi K3.1 Pro", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 }],
		["k3.1-pro-highspeed", "Kimi K3.1 Pro Highspeed", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 4 }],
	] as const)("registers %s with the documented limits", (id, name, cost) => {
		const model = getBuiltinModel("kimi-coding", id);
		expect(model).toBeDefined();
		expect(model?.id).toBe(id);
		expect(model?.name).toBe(name);
		expect(model?.api).toBe("anthropic-messages");
		expect(model?.baseUrl).toBe("https://api.kimi.com/coding");
		expect(model?.reasoning).toBe(true);
		expect(model?.contextWindow).toBe(1048576);
		expect(model?.maxTokens).toBe(131072);
		expect(model?.input).toEqual(["text", "image", "video"]);
		expect(model?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
		expect(model?.cost).toEqual(cost);
		expect(model?.compat).toMatchObject({ forceAdaptiveThinking: true, allowEmptySignature: true });
	});
});
