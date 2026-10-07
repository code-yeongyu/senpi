import { describe, expect, it } from "vitest";
import { Type } from "../src/index.ts";
import { createModels } from "../src/models.ts";
import { baiProvider } from "../src/providers/bai.ts";
import type { Api, Context, Model } from "../src/types.ts";
import { BAI_LIVE_TEST_FLAG, getLiveEnvApiKey } from "./live-api-gates.ts";

const apiKey = getLiveEnvApiKey("BAI_API_KEY", BAI_LIVE_TEST_FLAG);

const workpool = {
	name: "workpool",
	description: "Union-root function schema compatibility probe.",
	parameters: Type.Union([
		Type.Object({ op: Type.Literal("create"), name: Type.String() }),
		Type.Object({ op: Type.Literal("inspect"), pool_id: Type.String() }),
	]),
};

const context: Context = {
	systemPrompt: "Reply with exactly OK. Do not call tools.",
	messages: [{ role: "user", content: "Reply with exactly OK.", timestamp: 1 }],
	tools: [workpool],
};

describe.skipIf(!apiKey)("B.AI live provider", () => {
	it("discovers models and completes one request through each available wire API", async () => {
		const models = createModels();
		models.setProvider(baiProvider());
		const refresh = await models.refresh({ providers: ["bai"], force: true });
		expect(refresh.errors.size).toBe(0);

		const available = models.getModels("bai");
		const selected = new Map<Api, Model<Api>>();
		for (const model of available) {
			if (!selected.has(model.api)) selected.set(model.api, model);
		}
		expect(selected.size).toBeGreaterThan(0);

		for (const model of selected.values()) {
			const result = await models.completeSimple(model, context, {
				apiKey: apiKey!,
				maxTokens: 32,
			});
			expect(result.stopReason).not.toBe("error");
			expect(result.content.some((block) => block.type === "text" && block.text.length > 0)).toBe(true);
		}
	});
});
