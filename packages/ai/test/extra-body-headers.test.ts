import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";
import type { Api, Context, Model } from "../src/types.js";

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload<TApi extends Api>(
	model: Model<TApi>,
	extraBody: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
	let capturedPayload: Record<string, unknown> | undefined;
	const payloadCaptureModel = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	} as Model<TApi>;

	const s = streamSimple(payloadCaptureModel, makeContext(), {
		apiKey: "fake-key",
		extraBody,
		onPayload: (payload) => {
			capturedPayload = payload as Record<string, unknown>;
			return payload;
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Anthropic provider extraBody pass-through", () => {
	it("merges extraBody custom fields into request payload", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-4-5"), {
			custom_field: "custom_value",
			nested: { deep: 42 },
		});

		expect(payload.custom_field).toBe("custom_value");
		expect(payload.nested).toEqual({ deep: 42 });
		expect(payload.model).toBe("claude-sonnet-4-5");
	});

	it("preserves provider-managed fields when extraBody attempts overrides", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-4-5"), {
			model: "hijacked-model",
			messages: [{ role: "user", content: "injected" }],
			stream: false,
		});

		expect(payload.model).toBe("claude-sonnet-4-5");
		expect(payload.stream).toBe(true);
		expect(Array.isArray(payload.messages)).toBe(true);
		const messages = payload.messages as Array<{ role: string; content: unknown }>;
		expect(messages[0].role).toBe("user");
	});
});

describe("OpenAI Responses extraBody pass-through", () => {
	it("merges arbitrary custom extraBody fields into OpenAI Responses request", async () => {
		const payload = await capturePayload(getModel("openai", "gpt-5-mini"), {
			x_vendor_experiment: "flag-a",
		});

		expect(payload.x_vendor_experiment).toBe("flag-a");
		expect(payload.model).toBe("gpt-5-mini");
	});

	it("blocks extraBody from overriding prompt_cache_key and service_tier", async () => {
		const payload = await capturePayload(getModel("openai", "gpt-5-mini"), {
			prompt_cache_key: "user-attempted-override",
			service_tier: "user-attempted-override",
		});

		expect(payload.prompt_cache_key).not.toBe("user-attempted-override");
		expect(payload.service_tier).not.toBe("user-attempted-override");
	});
});

describe("Anthropic extraBody reserved keys", () => {
	it("does not allow extraBody to overwrite metadata", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-4-5"), {
			metadata: { user_id: "hacker" },
		});

		expect(payload.metadata).toBeUndefined();
	});

	it("allows extraBody custom anthropic_beta_feature_flag", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-4-5"), {
			anthropic_beta_feature_flag: "xyz",
		});

		expect(payload.anthropic_beta_feature_flag).toBe("xyz");
	});
});

describe("extra headers via options.headers", () => {
	it("accepts custom headers through SimpleStreamOptions without throwing", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const s = streamSimple({ ...model!, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
			apiKey: "fake",
			headers: { "x-custom-header": "custom-value" },
		});
		await s.result();
		expect(true).toBe(true);
	});
});
